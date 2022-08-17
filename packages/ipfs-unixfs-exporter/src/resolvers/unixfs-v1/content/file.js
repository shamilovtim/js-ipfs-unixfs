import extractDataFromBlock from '../../../utils/extract-data-from-block.js'
import validateOffsetAndLength from '../../../utils/validate-offset-and-length.js'
import { UnixFS } from 'ipfs-unixfs'
import errCode from 'err-code'
import * as dagPb from '@ipld/dag-pb'
import * as raw from 'multiformats/codecs/raw'
import { pushable } from 'it-pushable'
import parallel from 'it-parallel'
import { pipe } from 'it-pipe'
import map from 'it-map'

/**
 * @typedef {import('../../../types').ExporterOptions} ExporterOptions
 * @typedef {import('interface-blockstore').Blockstore} Blockstore
 * @typedef {import('@ipld/dag-pb').PBNode} PBNode
 * @typedef {import('@ipld/dag-pb').PBLink} PBLink
 */

/**
 * @param {Blockstore} blockstore
 * @param {PBNode | Uint8Array} node
 * @param {import('it-pushable').Pushable<Uint8Array | undefined>} queue
 * @param {number} streamPosition
 * @param {number} start
 * @param {number} end
 * @param {ExporterOptions} options
 * @returns {Promise<void>}
 */
async function walkDAG (blockstore, node, queue, streamPosition, start, end, options) {
  // a `raw` node
  if (node instanceof Uint8Array) {
    queue.push(extractDataFromBlock(node, streamPosition, start, end))

    return
  }

  if (node.Data == null) {
    throw errCode(new Error('no data in PBNode'), 'ERR_NOT_UNIXFS')
  }

  /** @type {UnixFS} */
  let file

  try {
    file = UnixFS.unmarshal(node.Data)
  } catch (/** @type {any} */ err) {
    throw errCode(err, 'ERR_NOT_UNIXFS')
  }

  // might be a unixfs `raw` node or have data on intermediate nodes
  if (file.data != null) {
    const data = file.data
    const buf = extractDataFromBlock(data, streamPosition, start, end)

    queue.push(buf)

    streamPosition += buf.byteLength
  }

  /** @type {Array<{ link: PBLink, blockStart: number }>} */
  const childOps = []

  for (let i = 0; i < node.Links.length; i++) {
    const childLink = node.Links[i]
    const childStart = streamPosition // inclusive
    const childEnd = childStart + file.blockSizes[i] // exclusive

    if ((start >= childStart && start < childEnd) || // child has offset byte
        (end >= childStart && end <= childEnd) || // child has end byte
        (start < childStart && end > childEnd)) { // child is between offset and end bytes
      childOps.push({
        link: childLink,
        blockStart: streamPosition
      })
    }

    streamPosition = childEnd

    if (streamPosition > end) {
      break
    }
  }

  await pipe(
    childOps,
    (source) => map(source, (op) => {
      return async () => {
        const block = await blockstore.get(op.link.Hash, {
          signal: options.signal
        })

        return {
          ...op,
          block
        }
      }
    }),
    (source) => parallel(source, {
      ordered: true
    }),
    async (source) => {
      for await (const { link, block, blockStart } of source) {
        let child
        switch (link.Hash.code) {
          case dagPb.code:
            child = await dagPb.decode(block)
            break
          case raw.code:
            child = block
            break
          default:
            throw errCode(new Error(`Unsupported codec: ${link.Hash.code}`), 'ERR_NOT_UNIXFS')
        }

        await walkDAG(blockstore, child, queue, blockStart, start, end, options)
      }
    }
  )
}

/**
 * @type {import('../').UnixfsV1Resolver}
 */
const fileContent = (cid, node, unixfs, path, resolve, depth, blockstore) => {
  /**
   * @param {ExporterOptions} options
   */
  async function * yieldFileContent (options = {}) {
    const fileSize = unixfs.fileSize()

    if (fileSize === undefined) {
      throw new Error('File was a directory')
    }

    const {
      offset,
      length
    } = validateOffsetAndLength(fileSize, options.offset, options.length)

    if (length === 0) {
      return
    }

    const queue = pushable({
      objectMode: true
    })

    walkDAG(blockstore, node, queue, 0, offset, offset + length, options)
      .catch(err => {
        queue.end(err)
      })

    let read = 0

    for await (const buf of queue) {
      if (buf != null) {
        yield buf

        read += buf.byteLength

        if (read === length) {
          queue.end()
        }
      }
    }
  }

  return yieldFileContent
}

export default fileContent
