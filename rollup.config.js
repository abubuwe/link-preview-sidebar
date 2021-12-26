import dotenv from 'dotenv';
dotenv.config();
import path from 'path'

import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import typescript from '@rollup/plugin-typescript'

import { chromeExtension, simpleReloader } from 'rollup-plugin-chrome-extension'
import { emptyDir } from 'rollup-plugin-empty-dir'
// import zip from 'rollup-plugin-zip'
import replace from '@rollup/plugin-replace'
// import json from '@rollup/plugin-json'
import copy from 'rollup-plugin-cpy'

const isProduction = process.env.NODE_ENV === 'production'

export default {
  input: 'manifest.json',
  output: {
    dir: 'dist',
    format: 'esm',
    chunkFileNames: path.join('chunks','[name]-[hash].js'),
    sourcemap: isProduction ? false : true
  },
  plugins: [
    replace({
      'process.env.NODE_ENV': isProduction ? JSON.stringify( 'production' ) : JSON.stringify( 'development' ),
      'process.env.CB_API_KEY': JSON.stringify(process.env.CB_API_KEY),
      preventAssignment: true
    }),
    chromeExtension(),
    // Adds a Chrome extension reloader during watch mode
    simpleReloader(),
    resolve({browser: true}),
    commonjs(),
    typescript(),
    emptyDir(),
    copy([
      { files: 'rules.json', dest: './dist/' },
    ]),
    // Outputs a zip file in ./releases
    // isProduction && zip({ dir: 'releases' }),
    // Empties the output dir before a new build
  ],
}