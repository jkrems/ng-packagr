import ora, { type Ora } from 'ora';
import * as path from 'path';
import { glob } from 'tinyglobby';
import { AssetPattern } from '../../../ng-package.schema';
import { BuildGraph } from '../../graph/build-graph';
import { Node } from '../../graph/node';
import { isInProgress } from '../../graph/select';
import { transformFromPromise } from '../../graph/transform';
import { colors } from '../../utils/color';
import { copyFile, exists, readFile, rmdir, stat, writeFile } from '../../utils/fs';
import * as log from '../../utils/log';
import { ensureUnixPath } from '../../utils/path';
import { EntryPointNode, PackageNode, fileUrl, isEntryPoint, isPackage } from '../nodes';
import { NgPackagrOptions } from '../options.di';
import { NgPackage } from '../package';
import { NgEntryPoint } from './entry-point';

type CompilationMode = 'partial' | 'full' | undefined;

export const writePackageTransform = (options: NgPackagrOptions) =>
  transformFromPromise(async graph => {
    const spinner = ora({ hideCursor: false, discardStdin: false });
    const entryPoints = graph.filter(isEntryPoint);
    const entryPoint = entryPoints.find(isInProgress);
    const ngEntryPoint: NgEntryPoint = entryPoint.data.entryPoint;
    const ngPackageNode: PackageNode = graph.find(isPackage);
    const ngPackage = ngPackageNode.data;
    const { destinationFiles } = entryPoint.data;

    if (!ngEntryPoint.isSecondaryEntryPoint) {
      spinner.start('Copying assets');
      try {
        await copyAssets(graph, entryPoint, ngPackageNode, entryPoints);
      } catch (error) {
        spinner.fail();
        throw error;
      }
      spinner.succeed();
    }

    // 6. WRITE PACKAGE.JSON
    const relativeUnixFromDestPath = (filePath: string) =>
      ensureUnixPath(path.relative(ngEntryPoint.destinationPath, filePath));

    if (!ngEntryPoint.isSecondaryEntryPoint) {
      try {
        spinner.start('Writing package manifest');
        if (!options.watch) {
          const primary = ngPackageNode.data.primary;
          await writeFile(
            path.join(primary.destinationPath, '.npmignore'),
            `# Nested package.json's are only needed for development.\n**/package.json`,
          );
        }

        const { compilationMode } = entryPoint.data.tsConfig.options;

        await writePackageJson(
          ngEntryPoint,
          ngPackage,
          {
            module: relativeUnixFromDestPath(destinationFiles.fesm2022),
            typings: relativeUnixFromDestPath(destinationFiles.declarationsBundled),
            exports: generatePackageExports(ngEntryPoint, entryPoints),
            // webpack v4+ specific flag to enable advanced optimizations and code splitting
            sideEffects: ngEntryPoint.packageJson.sideEffects ?? false,
          },
          !!options.watch,
          compilationMode as CompilationMode,
          spinner,
        );
      } catch (error) {
        spinner.fail();
        throw error;
      }
      spinner.succeed();
    } else if (ngEntryPoint.isSecondaryEntryPoint) {
      if (options.watch) {
        // Update the watch version of the primary entry point `package.json` file.
        // this is needed because of Webpack's 5 `cachemanagedpaths`
        // https://github.com/ng-packagr/ng-packagr/issues/2069
        const primary = ngPackageNode.data.primary;
        const packageJsonPath = path.join(primary.destinationPath, 'package.json');

        if (await exists(packageJsonPath)) {
          const packageJson = JSON.parse(await readFile(packageJsonPath, { encoding: 'utf8' }));
          packageJson.version = generateWatchVersion();
          await writeFile(
            path.join(primary.destinationPath, 'package.json'),
            JSON.stringify(packageJson, undefined, 2),
          );
        }
      }

      // Write a package.json in each secondary entry-point
      // This is need for esbuild to secondary entry-points in dist correctly.
      await writeFile(
        path.join(ngEntryPoint.destinationPath, 'package.json'),
        JSON.stringify({ module: relativeUnixFromDestPath(destinationFiles.fesm2022) }, undefined, 2),
      );
    }

    spinner.succeed(`Built ${ngEntryPoint.moduleId}`);
  });

type AssetEntry = Exclude<AssetPattern, string>;

async function copyAssets(
  graph: BuildGraph,
  entryPointNode: EntryPointNode,
  ngPackageNode: PackageNode,
  entryPoints: EntryPointNode[],
): Promise<void> {
  const ngPackage = ngPackageNode.data;
  const globsForceIgnored: string[] = ['.gitkeep', '**/.DS_Store', '**/Thumbs.db', `${ngPackage.dest}/**`];
  const defaultAssets: AssetEntry[] = [
    { glob: 'LICENSE', input: '/', output: '/' },
    ...entryPoints.map(({ data }) => {
      const subpath = data.entryPoint.destinationFiles.directory || '/';

      return { glob: 'README.md', input: subpath, output: subpath };
    }),
  ];

  const assets: AssetEntry[] = [];
  for (const assetPath of [...ngPackage.assets, ...defaultAssets]) {
    let asset: AssetEntry;
    if (typeof assetPath === 'object') {
      asset = { ...assetPath };
    } else {
      const [isDir, isFile] = await stat(path.join(ngPackage.src, assetPath))
        .then(stats => [stats.isDirectory(), stats.isFile()])
        .catch(() => [false, false]);
      if (isDir) {
        asset = { glob: '**/*', input: assetPath, output: assetPath };
      } else if (isFile) {
        // filenames are their own glob
        asset = { glob: path.basename(assetPath), input: path.dirname(assetPath), output: path.dirname(assetPath) };
      } else {
        asset = { glob: assetPath, input: '/', output: '/' };
      }
    }

    asset.input = path.join(ngPackage.src, asset.input);
    asset.output = path.join(ngPackage.dest, asset.output);

    const isAncestorPath = (target: string, datum: string) => path.relative(datum, target).startsWith('..');
    if (isAncestorPath(asset.input, ngPackage.src)) {
      throw new Error('Cannot read assets from a location outside of the project root.');
    }
    if (isAncestorPath(asset.output, ngPackage.dest)) {
      throw new Error('Cannot write assets to a location outside of the output path.');
    }

    assets.push(asset);
  }

  for (const asset of assets) {
    const filePaths = await glob(asset.glob, {
      cwd: asset.input,
      ignore: [...(asset.ignore ?? []), ...globsForceIgnored],
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: asset.followSymlinks,
    });
    for (const filePath of filePaths) {
      const fileSrcFullPath = path.join(asset.input, filePath);
      const fileDestFullPath = path.join(asset.output, filePath);
      const nodeUri = fileUrl(ensureUnixPath(fileSrcFullPath));
      let node = graph.get(nodeUri);
      if (!node) {
        node = new Node(nodeUri);
        graph.put(node);
      }
      entryPointNode.dependsOn(node);
      await copyFile(fileSrcFullPath, fileDestFullPath);
    }
  }
}

/**
 * Creates and writes a `package.json` file of the entry point used by the `node_module`
 * resolution strategies.
 *
 * #### Example
 *
 * A consumer of the entry point depends on it by `import {..} from '@my/module/id';`.
 * The module id `@my/module/id` will be resolved to the `package.json` file that is written by
 * this build step.
 * The properties `main`, `module`, `typings` (and so on) in the `package.json` point to the
 * flattened JavaScript bundles, type definitions, (...).
 *
 * @param entryPoint An entry point of an Angular package / library
 * @param additionalProperties Additional properties, e.g. binary artefacts (bundle files), to merge into `package.json`
 */
async function writePackageJson(
  entryPoint: NgEntryPoint,
  pkg: NgPackage,
  additionalProperties: { [key: string]: string | boolean | string[] | ConditionalExport },
  isWatchMode: boolean,
  compilationMode: CompilationMode,
  spinner: Ora,
): Promise<void> {
  log.debug('Writing package.json');

  // set additional properties
  const packageJson = { ...entryPoint.packageJson, ...additionalProperties };

  // read tslib version from `@angular/compiler` so that our tslib
  // version at least matches that of angular if we use require('tslib').version
  // it will get what installed and not the minimum version nor if it is a `~` or `^`
  // this is only required for primary
  if (isWatchMode) {
    // Needed because of Webpack's 5 `cachemanagedpaths`
    // https://github.com/angular/angular-cli/issues/20962
    packageJson.version = generateWatchVersion();
  }

  if (!packageJson.peerDependencies?.tslib && !packageJson.dependencies?.tslib) {
    const {
      peerDependencies: angularPeerDependencies = {},
      dependencies: angularDependencies = {},
    } = require('@angular/compiler/package.json');
    const tsLibVersion = angularPeerDependencies.tslib || angularDependencies.tslib;

    if (tsLibVersion) {
      packageJson.dependencies = { ...packageJson.dependencies, tslib: tsLibVersion };
    }
  } else if (packageJson.peerDependencies?.tslib) {
    spinner.warn(
      colors.yellow(
        `'tslib' is no longer recommended to be used as a 'peerDependencies'. Moving it to 'dependencies'.`,
      ),
    );
    packageJson.dependencies = { ...(packageJson.dependencies || {}), tslib: packageJson.peerDependencies.tslib };

    delete packageJson.peerDependencies.tslib;
  }

  // Verify non-peerDependencies as they can easily lead to duplicate installs or version conflicts
  // in the node_modules folder of an application
  const allowedList = pkg.allowedNonPeerDependencies.map(value => new RegExp(value));
  try {
    checkNonPeerDependencies(packageJson, 'dependencies', allowedList, spinner);
  } catch (e) {
    await rmdir(entryPoint.destinationPath, { recursive: true });
    throw e;
  }

  // Removes scripts from package.json after build
  if (packageJson.scripts) {
    if (pkg.keepLifecycleScripts !== true) {
      spinner.info(`Removing scripts section in package.json as it's considered a potential security vulnerability.`);
      delete packageJson.scripts;
    } else {
      spinner.warn(
        colors.yellow(
          `You enabled keepLifecycleScripts explicitly. The scripts section in package.json will be published to npm.`,
        ),
      );
    }
  }

  if (compilationMode !== 'partial') {
    const scripts = packageJson.scripts || (packageJson.scripts = {});
    scripts.prepublishOnly =
      'node --eval "console.error(\'' +
      'ERROR: Trying to publish a package that has been compiled in full compilation mode. This is not allowed.\\n' +
      'Please delete and rebuild the package with partial compilation mode, before attempting to publish.\\n' +
      '\')" ' +
      '&& exit 1';
  }

  // keep the dist package.json clean
  // this will not throw if ngPackage field does not exist
  delete packageJson.ngPackage;

  const packageJsonPropertiesToDelete = [
    'stylelint',
    'prettier',
    'browserslist',
    'devDependencies',
    'jest',
    'workspaces',
    'husky',
  ];

  for (const prop of packageJsonPropertiesToDelete) {
    if (prop in packageJson) {
      delete packageJson[prop];
      spinner.info(`Removing ${prop} section in package.json.`);
    }
  }

  packageJson.name = entryPoint.moduleId;
  await writeFile(path.join(entryPoint.destinationPath, 'package.json'), JSON.stringify(packageJson, undefined, 2));
}

function checkNonPeerDependencies(
  packageJson: Record<string, unknown>,
  property: string,
  allowed: RegExp[],
  spinner: Ora,
) {
  if (!packageJson[property]) {
    return;
  }

  for (const dep of Object.keys(packageJson[property])) {
    if (allowed.some(regex => regex.test(dep))) {
      log.debug(`Dependency ${dep} is allowed in '${property}'`);
    } else {
      spinner.warn(
        colors.yellow(
          `Distributing npm packages with '${property}' is not recommended. Please consider adding ${dep} ` +
            `to 'peerDependencies' or remove it from '${property}'.`,
        ),
      );
      throw new Error(`Dependency ${dep} must be explicitly allowed using the "allowedNonPeerDependencies" option.`);
    }
  }
}

type PackageExports = Record<string, ConditionalExport>;

/**
 * Type describing the conditional exports descriptor for an entry-point.
 * https://nodejs.org/api/packages.html#packages_conditional_exports
 */
type ConditionalExport = { types?: string; default?: string };

/**
 * Generates the `package.json` package exports following APF v13.
 * This is supposed to match with: https://github.com/angular/angular/blob/e0667efa6eada64d1fb8b143840689090fc82e52/packages/bazel/src/ng_package/packager.ts#L415.
 */
function generatePackageExports(
  { destinationPath, packageJson }: NgEntryPoint,
  entryPoints: EntryPointNode[],
): PackageExports {
  const exports: PackageExports = packageJson.exports ? JSON.parse(JSON.stringify(packageJson.exports)) : {};

  const insertMappingOrError = (subpath: string, mapping: ConditionalExport) => {
    exports[subpath] ??= {};
    const subpathExport = exports[subpath];

    // Go through all conditions that should be inserted. If the condition is already
    // manually set of the subpath export, we throw an error. In general, we allow for
    // additional conditions to be set. These will always precede the generated ones.
    for (const conditionName of Object.keys(mapping)) {
      if (subpathExport[conditionName] !== undefined) {
        log.warn(
          `Found a conflicting export condition for "${subpath}". The "${conditionName}" ` +
            `condition would be overridden by ng-packagr. Please unset it.`,
        );
      }

      // **Note**: The order of the conditions is preserved even though we are setting
      // the conditions once at a time (the latest assignment will be at the end).
      subpathExport[conditionName] = mapping[conditionName];
    }
  };

  const relativeUnixFromDestPath = (filePath: string) =>
    './' + ensureUnixPath(path.relative(destinationPath, filePath));

  insertMappingOrError('./package.json', { default: './package.json' });

  for (const entryPoint of entryPoints) {
    const { destinationFiles, isSecondaryEntryPoint } = entryPoint.data.entryPoint;
    const subpath = isSecondaryEntryPoint ? `./${destinationFiles.directory}` : '.';

    insertMappingOrError(subpath, {
      types: relativeUnixFromDestPath(destinationFiles.declarationsBundled),
      default: relativeUnixFromDestPath(destinationFiles.fesm2022),
    });
  }

  return exports;
}

/**
 * Generates a new version for the package `package.json` when runing in watch mode.
 */
function generateWatchVersion() {
  return `0.0.0-watch+${Date.now()}`;
}
