/* eslint-disable max-statements */
/* eslint-disable linebreak-style */
// NOTE: we only support baseline and progressive JPGs here
// due to the structure of the loader class, we only get a buffer
// with a maximum size of 4096 bytes. so if the SOF marker is outside
// if this range we can't detect the file size correctly.

import type { IImage, ISize } from './interface'
import { readUInt, readUInt16BE, toHexString } from './utils'

const EXIF_MARKER = '45786966'
const APP1_DATA_SIZE_BYTES = 2
const EXIF_HEADER_BYTES = 6
const TIFF_BYTE_ALIGN_BYTES = 2
const BIG_ENDIAN_BYTE_ALIGN = '4d4d'
const LITTLE_ENDIAN_BYTE_ALIGN = '4949'

// Each entry is exactly 12 bytes
const IDF_ENTRY_BYTES = 12
const NUM_DIRECTORY_ENTRIES_BYTES = 2

function isEXIF(input: Uint8Array): boolean {
  return toHexString(input, 2, 6) === EXIF_MARKER
}

function extractSize(input: Uint8Array, index: number): ISize {
  return {
    height: readUInt16BE(input, index),
    width: readUInt16BE(input, index + 2),
  }
}

function extractOrientationFromOffset(exifBlock: Uint8Array, idfDirectoryEntries: number, offset: number, isBigEndian: boolean) {
  let exifOffset : number | undefined = undefined
  let orientation : number | undefined = undefined

  for (
    let directoryEntryNumber = 0;
    directoryEntryNumber < idfDirectoryEntries;
    directoryEntryNumber++
  ) {
    const start =
      offset +
      NUM_DIRECTORY_ENTRIES_BYTES +
      directoryEntryNumber * IDF_ENTRY_BYTES
    const end = start + IDF_ENTRY_BYTES

    // Skip on corrupt EXIF blocks
    if (start > exifBlock.length) {
      return [undefined, undefined]
    }

    const block = exifBlock.slice(start, end)
    const tagNumber = readUInt(block, 16, 0, isBigEndian)

    // 0x0112 (decimal: 274) is the `orientation` tag ID
    if (tagNumber === 274) {
      const dataFormat = readUInt(block, 16, 2, isBigEndian)
      if (dataFormat !== 3) {
        return [undefined, undefined]
      }

      // unsinged int has 2 bytes per component
      // if there would more than 4 bytes in total it's a pointer
      const numberOfComponents = readUInt(block, 32, 4, isBigEndian)
      if (numberOfComponents !== 1) {
        return [undefined, undefined]
      }

      orientation = readUInt(block, 16, 8, isBigEndian)
    } else if (tagNumber == 34665) { // Exif Offset
      exifOffset = readUInt(block, 32, 8, isBigEndian) 
    }
  }  

  return [orientation, exifOffset]
}

function extractOrientation(exifBlock: Uint8Array, isBigEndian: boolean) {
  const tiffHeaderOffset = 4 // endianness and magic number

  let offset = readUInt(exifBlock, 32, tiffHeaderOffset + EXIF_HEADER_BYTES, isBigEndian) + EXIF_HEADER_BYTES

  let idfDirectoryEntries = readUInt(exifBlock, 16, offset, isBigEndian)

  let orientation: number | undefined
  let exifOffset: number | undefined;
  
  [orientation, exifOffset] = extractOrientationFromOffset(exifBlock, idfDirectoryEntries, offset, isBigEndian)

  if (!orientation && exifOffset) {
    offset = exifOffset + EXIF_HEADER_BYTES
    idfDirectoryEntries = readUInt(exifBlock, 16, offset, isBigEndian);
    [orientation, exifOffset] = extractOrientationFromOffset(exifBlock, idfDirectoryEntries, offset, isBigEndian)
  }

  if (!orientation) {
    orientation = 0
  }

  return orientation
}

function validateExifBlock(input: Uint8Array, index: number) {
  // Skip APP1 Data Size
  const exifBlock = input.slice(APP1_DATA_SIZE_BYTES, index)

  // Consider byte alignment
  const byteAlign = toHexString(
    exifBlock,
    EXIF_HEADER_BYTES,
    EXIF_HEADER_BYTES + TIFF_BYTE_ALIGN_BYTES
  )

  // Ignore Empty EXIF. Validate byte alignment
  const isBigEndian = byteAlign === BIG_ENDIAN_BYTE_ALIGN
  const isLittleEndian = byteAlign === LITTLE_ENDIAN_BYTE_ALIGN

  if (isBigEndian || isLittleEndian) {
    return extractOrientation(exifBlock, isBigEndian)
  }
}

export const JPG: IImage = {
  validate: (input) => toHexString(input, 0, 2) === 'ffd8',

  calculate(input) {
    if (!this.validate(input)) {
      throw new TypeError('Invalid JPG, no SOI marker found!')      
    }
    input = input.slice(2)

    let orientation: number | undefined = undefined
    let width: number | undefined = undefined
    let height: number | undefined = undefined
    while (input.length) {
      const marker = toHexString(input, 0, 1)
      const isValidMarker = marker === 'ff'

      if (!isValidMarker) {
        throw new TypeError('Invalid JPG, marker table corrupted')
      }

      // 0xFFC0 is baseline standard(SOF)
      // 0xFFC1 is baseline optimized(SOF)
      // 0xFFC2 is progressive(SOF2)
      const next = toHexString(input, 1, 2)
      if (next === 'c0' || next === 'c1' || next === 'c2') {
        const size = extractSize(input, 5)

        width = size.width
        height = size.height
      }      
      // 0xFFDA signifies the beginning of the image data
      if (next === 'da') {
        break
      }

      input = input.slice(2)

      // read length of the next block
      const i = readUInt16BE(input, 0)

      if (isEXIF(input)) {
        orientation = validateExifBlock(input, i)
      }

      if (width !== undefined && height !== undefined && orientation !== undefined) {
        return {
          height: height,
          orientation,
          width: width,
        }
      }

      if (i > input.length) {
        throw new TypeError('Corrupt JPG, exceeded buffer limits')
      }

      // move to the next block
      input = input.slice(i)
    }

    return {
      height: height,
      orientation,
      width: width,
    }    
  },
}
