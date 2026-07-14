#!/usr/bin/env node
import { captureProviderDom } from './capture-provider-dom-cdp.mjs'

const result = await captureProviderDom({
  forcedProvider: 'chatgpt',
  programName: 'test/helpers/capture-chatgpt-dom-cdp.mjs',
})

if (!result.ok) process.exitCode = 1
