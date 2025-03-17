import { readFileSync } from 'fs'
import { imageSize } from './lib'

const file = 'specs/images/valid/jpg/optimized.jpg'
const buffer = readFileSync(file)
const bufferDimensions = imageSize(buffer)

console.log(bufferDimensions)

