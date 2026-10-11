# Local Source Scanner V1 Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a local Node.js CLI that inventories source repositories and emits a privacy-conscious, versioned JSON assessment report.

**Architecture:** An async file walker feeds per-file inventory and statistics. A stateless analyzer registry runs language, dependency, and technology analyzers against per-scan context; a report builder whitelists exported fields and the CLI handles paths, progress, and output.

**Tech Stack:** Node.js ES modules, npm, `node:test`, built-in filesystem/stream/path modules, `fast-xml-parser` for XML and `@iarna/toml` for TOML.

**Spec:** User-provided Local Source Code Scanner V1 prompt.

## Global Constraints

- Require Node.js `>=22.0.0`; recommend a maintained LTS release.
- Never execute scanned files, scripts, package managers, or build tools; never make network requests.
- Do not modify source files or export their contents, secrets, absolute paths, or environment values by default.
- Do not follow symlinks; enforce file-count and file-size limits and represent incomplete work accurately.
- Use direct manifest declarations only; do not claim resolved dependency graphs or cloud-readiness.

## Review Focus

- A symlink or output path must not escape the selected root or overwrite scanned source without explicit opt-in. Test walker symlink handling and CLI output safety.
- A file-count limit, unreadable file, malformed manifest, or analyzer failure must preserve successful work and report incompleteness. Test partial status and analyzer isolation.
- Malformed or adversarial JSON, XML, TOML, and requirements declarations must not crash scanning or leak source text. Test parser failures and safe output.
- Secret-like files and source snippets must not enter the report. Test `.env`/key exclusions and a serialized report containing neither secret fixture nor source text.
- Binary, oversized, excluded, and nested files must produce deterministic inventory and skip records. Test those cases in walker and scanner fixtures.

---

### Task 1: Project scaffold and safe paths

**Files:** `package.json`, `.gitignore`, `src/utils/safe-path.js`, `src/utils/errors.js`, `test/safe-path.test.js`

**Interfaces:** `isPathInside(root, candidate)`, `toReportPath(root, candidate, includeAbsolutePaths)`, and sanitized structured scan errors.

- [ ] Write tests for path containment, relative report paths, and error sanitization; run `node --test test/safe-path.test.js` and confirm the expected missing-export failures.
- [ ] Add the ES module package metadata, Node engine floor, test/start scripts, and parser dependencies; implement the safe path and error helpers.
- [ ] Run the focused test and `npm test`; both must pass.

### Task 2: Walking and file classification

**Files:** `src/repository/file-walker.js`, `src/repository/file-classifier.js`, `test/file-walker.test.js`

**Interfaces:** `walkRepository(root, options)` is an async generator of file/exclusion/error events; `classifyFile(relativePath)` returns extension, language, category and project/build/dependency/test/config/documentation flags.

- [ ] Test nested paths, default and extended directory exclusions, symlinks, sensitive files, binary/compiled artifacts, size caps, and file-count truncation; run the focused test and confirm it fails on missing exports.
- [ ] Implement deterministic extension/manifest registries and a non-following async walker that verifies root containment and reports every intentional skip.
- [ ] Run the focused test and `npm test`; a file-count truncation must emit a limit event instead of silently ending.

### Task 3: Analyzer registry and language statistics

**Files:** `src/analyzers/analyzer-registry.js`, `src/analyzers/language-analyzer.js`, `test/language-analyzer.test.js`

**Interfaces:** `Analyzer({id, version}).analyze(context)`; registry methods `register`, `get`, `list`, and `run(context, ids)` return successful results plus sanitized failures. Language analyzer returns language counts, sizes, lines, blanks, and honest comment availability.

- [ ] Test language/compound extension mapping, streaming line counts, JSON's supported zero-comment count, unavailable comment counts for ambiguous syntaxes, and one analyzer failing without losing another result.
- [ ] Implement stateless analyzers and isolated registry execution; stream eligible text files without retaining contents.
- [ ] Run focused and full tests. No supported comment parser means `null` plus an unavailable status, never a guessed count.

### Task 4: Projects and dependencies

**Files:** `src/repository/project-detector.js`, `src/analyzers/dependency-analyzer.js`, `test/project-detector.test.js`, `test/dependency-analyzer.test.js`

**Interfaces:** `detectProjects(files)` returns manifest-backed projects and path-containment relationships; dependency analyzer returns declared dependency records and private per-run manifest facts for technology detection.

- [ ] Test Node, .NET, Maven, Gradle, Python, Go, PHP, Ruby and Rust project markers; test package.json, requirements, pyproject TOML, .NET XML, Maven XML, malformed manifests, and unresolved declarations.
- [ ] Implement deterministic project rules and safe direct-declaration extraction with XML entities disabled. Gradle is recognized but dependency resolution remains explicitly unsupported.
- [ ] Run focused and full tests; parser errors become sanitized warnings and do not abort unrelated analysis.

### Task 5: Technology evidence and report schema

**Files:** `src/analyzers/technology-analyzer.js`, `src/reporting/report-builder.js`, `src/reporting/json-reporter.js`, `test/scanner.test.js`

**Interfaces:** technology analyzer returns evidence-backed findings; `buildReport(scanState)` returns the versioned allowlisted schema; `serializeReport(report)` returns JSON text.

- [ ] Test React, Spring Boot, ASP.NET Core, and Django findings with manifest evidence, declared versions, and confidence labels; assert private facts and source contents are absent from report serialization.
- [ ] Implement central technology rules and report fields for analysis timestamps/id/status/completeness, repository, files, languages, projects, technologies, dependencies, statistics, exclusions, errors, and warnings.
- [ ] Run focused and full tests; status and completeness must reflect truncation, unreadable inputs, and analyzer failures.

### Task 6: Scanner orchestration and CLI

**Files:** `src/scanner.js`, `src/cli.js`, `test/scanner.test.js`, `test/cli.test.js`

**Interfaces:** `scanRepository(root, options)` returns a report; CLI supports `scan <directory>`, `--output`, `--format json`, `--max-files`, `--max-file-size-mb`, `--include-tests`, repeated `--exclude-dir`, `--include-absolute-paths`, `--allow-output-in-repository`, and `--help`.

- [ ] Test invalid/missing roots, human progress/summary, JSON stdout, output writing, output overwrite protection, output write failure, limits and include-tests behavior.
- [ ] Implement async orchestration, fatal vs per-file errors, safe output location checks, and nonzero exit codes for scan-start/report-write failures.
- [ ] Run focused and full tests; JSON mode writes only the report to stdout and sends progress to stderr.

### Task 7: Privacy/integrity regression fixtures and documentation

**Files:** `test/privacy.test.js`, `examples/sample-report.json`, `README.md`

- [ ] Test mixed-language Node/.NET/Maven/Python fixtures, fake credentials in code and `.env`, no source mutation via before/after hashes, no network calls, excluded directories, malformed manifests, oversized files, and valid schema JSON.
- [ ] Add a representative generated-shape sample report and document actual tested commands, supported ecosystems, limits, privacy behavior, analyzer extension steps, and V1 limitations.
- [ ] Run `npm test`, scan a temporary sample repository with the documented CLI, parse its JSON, and verify no source snippets or fake secret values occur in the output.

