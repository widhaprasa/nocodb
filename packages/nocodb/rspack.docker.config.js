const { resolve } = require('path');
const { rspack } = require('@rspack/core');
const nodeExternals = require('webpack-node-externals');
const { TsCheckerRspackPlugin } = require('ts-checker-rspack-plugin');

/**
 * Production Docker build.
 *
 * Unlike `rspack.config.js` (which bundles `src/index.ts` as a UMD library),
 * this produces a runnable server bundle from the Docker entrypoint and emits
 * it as CommonJS so it can be started with `node dist/main.js`.
 *
 * Native / third-party deps stay external (`node_modules`) and are copied into
 * the image at runtime; `nocodb-sdk` and `@noco-local-integrations` are bundled.
 */
module.exports = {
  entry: './src/run/dockerEntry.ts',
  module: {
    rules: [
      {
        test: /\.node$/,
        loader: 'node-loader',
        options: {
          name: '[path][name].[ext]',
        },
      },
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: {
          sourceMaps: false,
          jsc: {
            parser: {
              syntax: 'typescript',
              tsx: true,
              decorators: true,
              dynamicImport: true,
            },
            transform: {
              legacyDecorator: true,
              decoratorMetadata: true,
            },
            target: 'es2017',
            loose: true,
            externalHelpers: false,
            keepClassNames: true,
          },
          module: {
            type: 'commonjs',
            strict: false,
            strictMode: true,
            lazy: false,
            noInterop: false,
          },
        },
      },
    ],
  },
  optimization: {
    minimize: false,
    nodeEnv: false,
  },
  externals: [
    nodeExternals({
      allowlist: ['nocodb-sdk'],
    }),
  ],
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.json', '.node'],
    tsConfig: {
      configFile: resolve('tsconfig.json'),
    },
    alias: {
      '@noco-local-integrations': resolve(__dirname, '../noco-integrations/packages'),
    },
  },
  mode: 'production',
  output: {
    filename: 'main.js',
    path: resolve(__dirname, 'dist'),
    library: {
      type: 'commonjs2',
    },
  },
  node: {
    __dirname: false,
  },
  plugins: [
    new rspack.EnvironmentPlugin({
      EE: true,
      NODE_ENV: 'production',
    }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: 'src/public', to: 'public' }],
    }),
    new TsCheckerRspackPlugin({
      typescript: {
        configFile: resolve('tsconfig.json'),
      },
    }),
  ],
  target: 'node',
};
