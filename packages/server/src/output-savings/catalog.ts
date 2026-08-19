export const OUTPUT_SAVINGS_ESTIMATOR = 'o200k_base' as const
export const OUTPUT_SAVINGS_RUNTIME_ID = 'tiktoken-o200k_base-1.0.22'
export const OUTPUT_SAVINGS_RUNTIME_VERSION = '1.0.22'
export const OUTPUT_SAVINGS_RUNTIME_DOWNLOAD_BYTES = 10_611_708
export const OUTPUT_SAVINGS_RUNTIME_INSTALLED_BYTES = 3_413_323
export const OUTPUT_SAVINGS_RUNTIME_LICENSE_FILE = 'THIRD_PARTY_LICENSES.txt'
export const OUTPUT_SAVINGS_RUNTIME_LICENSE_TEXT = `tiktoken 1.0.22
Repository: https://github.com/dqbd/tiktoken
License: MIT

MIT License

Copyright (c) 2022 OpenAI, Shantanu Jain

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

export const OUTPUT_SAVINGS_RUNTIME_CATALOG = Object.freeze({
  runtimeId: OUTPUT_SAVINGS_RUNTIME_ID,
  version: OUTPUT_SAVINGS_RUNTIME_VERSION,
  estimator: OUTPUT_SAVINGS_ESTIMATOR,
  downloadUrl: 'https://registry.npmjs.org/tiktoken/-/tiktoken-1.0.22.tgz',
  archiveSha256: '55c339e756fdb17604f7c7e3eb35d2bcbffe4d960e8096e50285d1cefa51dd90',
  downloadBytes: OUTPUT_SAVINGS_RUNTIME_DOWNLOAD_BYTES,
  installedBytes: OUTPUT_SAVINGS_RUNTIME_INSTALLED_BYTES,
  license: 'MIT',
  repository: 'https://github.com/dqbd/tiktoken',
  files: Object.freeze([
    Object.freeze({
      archivePath: 'package/lite/tiktoken.cjs',
      relativePath: 'lite/tiktoken.cjs',
      size: 1_033,
      sha256: '7fbe9fcd5d252b676bdd028fc0854b43a684957a49666cc576c24b9aee695cbe',
    }),
    Object.freeze({
      archivePath: 'package/lite/tiktoken_bg.cjs',
      relativePath: 'lite/tiktoken_bg.cjs',
      size: 13_469,
      sha256: '9112b2ae11d7cedd23915bfbf234269f21596fcdd8b73f5b2756bc6a63f02616',
    }),
    Object.freeze({
      archivePath: 'package/lite/tiktoken_bg.wasm',
      relativePath: 'lite/tiktoken_bg.wasm',
      size: 1_073_364,
      sha256: '870fa4e0d8fe30a02b4703b2c4e24e7a8d99dcf6a1e8416c14b239f52a2eed55',
    }),
    Object.freeze({
      archivePath: 'package/encoders/o200k_base.json',
      relativePath: 'encoders/o200k_base.json',
      size: 2_325_457,
      sha256: 'df53e1a5f146e33a1b144d12ad9d685ee1b54dbc8b0950791ed45c933b119dc1',
    }),
  ]),
})
