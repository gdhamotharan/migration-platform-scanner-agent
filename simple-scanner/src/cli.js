#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { isPathInside } from './utils/safe-path.js';
import { scanRepository, ScanStartError } from './scanner.js';
import { serializeReport } from './reporting/json-reporter.js';

const HELP_TEXT = `Local Source Intelligence Scanner v0.1.0

Usage:
  node src/cli.js scan <directory> [options]
  node src/cli.js --help

Options:
  --output <path>              Write the JSON report to a file
  --format json                Print JSON report to stdout (the default)
  --max-files <count>          Maximum regular files to inspect (default: 100000)
  --max-file-size-mb <size>    Maximum file size to read (default: 5)
  --include-tests              Include test files in line statistics
  --exclude-dir <name>         Add a directory name to the exclusion list (repeatable)
  --include-absolute-paths     Include absolute paths in the report
  --allow-output-in-repository Allow report output under the scanned repository
`;

class CliUsageError extends Error {}
class OutputWriteError extends Error {}
class OutputPolicyError extends Error {}

function positiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CliUsageError(`Invalid value for ${optionName}.`);
  return number;
}

export function parseCliArgs(args) {
  if (args.includes('--help') || args.length === 0) return { help: true };
  if (args[0] !== 'scan') throw new CliUsageError('Expected the scan command.');
  const repositoryPath = args[1];
  if (!repositoryPath || repositoryPath.startsWith('--')) throw new CliUsageError('A repository directory is required.');
  const options = { excludeDirs: [] };
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    if (['--include-tests', '--include-absolute-paths', '--allow-output-in-repository'].includes(option)) {
      if (option === '--include-tests') options.includeTests = true;
      if (option === '--include-absolute-paths') options.includeAbsolutePaths = true;
      if (option === '--allow-output-in-repository') options.allowOutputInRepository = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new CliUsageError(`A value is required for ${option}.`);
    index += 1;
    if (option === '--output') options.output = value;
    else if (option === '--format') {
      if (value !== 'json') throw new CliUsageError('Only the json format is supported.');
      options.format = value;
    } else if (option === '--max-files') options.maxFiles = positiveInteger(value, option);
    else if (option === '--max-file-size-mb') {
      const megabytes = Number(value);
      if (!Number.isFinite(megabytes) || megabytes <= 0 || megabytes * 1024 * 1024 > Number.MAX_SAFE_INTEGER) {
        throw new CliUsageError(`Invalid value for ${option}.`);
      }
      options.maxFileSizeBytes = Math.floor(megabytes * 1024 * 1024);
    } else if (option === '--exclude-dir') {
      if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
        throw new CliUsageError('The --exclude-dir value must be one directory name.');
      }
      options.excludeDirs.push(value);
    } else throw new CliUsageError('Unknown command-line option.');
  }
  return { help: false, repositoryPath, options };
}

async function realTargetPath(targetPath) {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    const suffix = [path.basename(targetPath)];
    let ancestor = path.dirname(targetPath);
    while (true) {
      try {
        return path.join(await realpath(ancestor), ...suffix);
      } catch (ancestorError) {
        if (!['ENOENT', 'ENOTDIR'].includes(ancestorError.code)) throw ancestorError;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

export async function assertOutputLocation(outputPath, repositoryPath, allowOutputInRepository = false, lexicalRepositoryPath = repositoryPath) {
  const targetPath = path.resolve(outputPath);
  const canonicalRoot = await realpath(repositoryPath);
  const canonicalTarget = await realTargetPath(targetPath);
  const lexicalInside = isPathInside(lexicalRepositoryPath, targetPath);
  const canonicalInside = isPathInside(canonicalRoot, canonicalTarget);
  if (lexicalInside && !canonicalInside) {
    throw new OutputPolicyError('Refusing to write a report through a path that resolves outside the scanned repository.');
  }
  const insideRepository = lexicalInside || canonicalInside;
  if (insideRepository && !allowOutputInRepository) {
    throw new OutputPolicyError('Refusing to write a report inside the scanned repository without --allow-output-in-repository.');
  }
  if (insideRepository) {
    try {
      await lstat(targetPath);
      throw new OutputPolicyError('Refusing to overwrite an existing path inside the scanned repository.');
    } catch (error) {
      if (error instanceof OutputPolicyError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return targetPath;
}

async function writeReport(outputPath, repositoryPath, content, allowOutputInRepository, lexicalRepositoryPath = repositoryPath) {
  const targetPath = await assertOutputLocation(outputPath, repositoryPath, allowOutputInRepository, lexicalRepositoryPath);
  const parentPath = path.dirname(targetPath);
  await mkdir(parentPath, { recursive: true });
  await assertOutputLocation(targetPath, repositoryPath, allowOutputInRepository, lexicalRepositoryPath);
  const canonicalRoot = await realpath(repositoryPath);
  const canonicalTarget = await realTargetPath(targetPath);
  const lexicalInside = isPathInside(lexicalRepositoryPath, targetPath);
  const canonicalInside = isPathInside(canonicalRoot, canonicalTarget);
  if (lexicalInside && !canonicalInside) {
    throw new OutputPolicyError('Refusing to write a report through a path that resolves outside the scanned repository.');
  }
  const insideRepository = lexicalInside || canonicalInside;
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = undefined;
    if (insideRepository) {
      await link(temporaryPath, targetPath);
      await rm(temporaryPath, { force: true });
    } else {
      await rename(temporaryPath, targetPath);
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function writeSummary(report, stderr) {
  stderr.write(`Scan ${report.analysis.status}: ${report.repository.total_files} files, ${report.languages.length} languages, ${report.projects.length} projects, ${report.dependencies.length} declared dependencies.\n`);
}

export async function runCli(args = process.argv.slice(2), io = process) {
  let parsed;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    io.stderr.write(`Error: ${error.message}\n`);
    io.stderr.write('Run with --help to see usage.\n');
    return 2;
  }
  if (parsed.help) {
    io.stdout.write(HELP_TEXT);
    return 0;
  }

  try {
    let repositoryPath;
    let lexicalRepositoryPath;
    try {
      lexicalRepositoryPath = path.resolve(parsed.repositoryPath);
      repositoryPath = await realpath(lexicalRepositoryPath);
    } catch (error) {
      const code = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code) ? error.code : 'SCAN_ERROR';
      const message = error.code === 'ENOENT'
        ? 'The requested repository directory does not exist or is inaccessible.'
        : 'The requested repository directory could not be accessed.';
      throw new ScanStartError(message, code);
    }
    const info = await stat(repositoryPath);
    if (!info.isDirectory()) throw new ScanStartError('The requested path is not a directory.', 'ENOTDIR');
    const outputPath = parsed.options.output ? path.resolve(parsed.options.output) : null;
    if (outputPath) {
      await assertOutputLocation(outputPath, repositoryPath, parsed.options.allowOutputInRepository, lexicalRepositoryPath);
    }
    io.stderr.write('Scanning repository...\n');
    const report = await scanRepository(repositoryPath, {
      ...parsed.options,
      onProgress: ({ filesProcessed }) => io.stderr.write(`Processed ${filesProcessed} files...\n`)
    });
    const json = serializeReport(report);
    if (outputPath) {
      try {
        await writeReport(outputPath, repositoryPath, json, parsed.options.allowOutputInRepository, lexicalRepositoryPath);
      } catch (error) {
        if (error instanceof OutputPolicyError) throw error;
        throw new OutputWriteError('The report could not be written.');
      }
      io.stderr.write('Report written locally.\n');
    } else {
      io.stdout.write(json);
    }
    writeSummary(report, io.stderr);
    return 0;
  } catch (error) {
    if (error instanceof ScanStartError) {
      io.stderr.write(`Scan error (${error.code}): ${error.message}\n`);
      return 2;
    }
    if (error instanceof OutputPolicyError) {
      io.stderr.write(`Output error: ${error.message}\n`);
      return 1;
    }
    if (error instanceof OutputWriteError) {
      io.stderr.write(`Output error: ${error.message}\n`);
      return 1;
    }
    io.stderr.write('Unable to complete the scan or write the report.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli();
}
