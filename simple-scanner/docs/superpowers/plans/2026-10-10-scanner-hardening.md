# Local Source Intelligence Scanner Hardening Plan

> **For agentic workers:** execute this plan inline, task by task, using test-first changes. No Git repository is present in the workspace, so do not create branches or commits.

**Goal:** Correct the scanner's .NET version attribution, inventory counters, analyzer outcomes, source metrics, project relationships, and report validation while preserving local-only static analysis.

**Architecture:** Keep the asynchronous walker and modular analyzer registry. Add a dedicated .NET metadata analyzer that reads only allowlisted MSBuild and SDK fields; make the report builder produce an explicit v2 contract and validate it against a checked-in JSON Schema plus semantic invariants.

**Tech Stack:** Node.js ES modules, `node:test`, existing XML/TOML parsers, Ajv 8 with formats for JSON Schema validation.

**Spec:** `C:/Users/dhamotharan/.codex/attachments/16b6c613-eaf3-4eba-a39b-2f934efec802/Pasted text.txt`

## Global Constraints

- Do not execute source code, `dotnet`, MSBuild, package managers, scripts, project plugins, or network requests.
- Preserve source-file contents and hashes; reports contain only allowlisted structured fields.
- Record conditional or property-based MSBuild declarations without evaluating them.
- Never infer an installed runtime version from a target framework or package version.
- Keep dependencies in `package.json` and `package-lock.json`; pin newly added schema-validator dependencies exactly.
- Bump the report schema to `2.0` because file-count and source-metric meanings are being corrected.
- No user-supplied .NET report or project is present: `scanner-src.zip` contains scanner source only. Build and label a synthetic .NET fixture; do not present it as customer input.

## Review Focus

- Conditional/imported MSBuild values: preserve raw declarations and mark unresolved instead of evaluating build logic.
- Central package versions and lockfiles: attach by project directory and report resolved versions only for unambiguous direct lock entries.
- Counter overlap: define primary inventory disposition separately from analyzer failures and unvisited files.
- Project/solution IDs: remain deterministic without embedding potentially sensitive path text in IDs.
- Schema semantics: validate status/completeness, counters, timestamps, and references in addition to JSON shape.

## Task 1: Inventory Categories, Counters, and Source Metrics

**Files:** `src/repository/file-classifier.js`, `src/repository/file-walker.js`, `src/scanner.js`, `src/analyzers/language-analyzer.js`, `src/reporting/report-builder.js`, corresponding tests.

- [ ] Add failing tests for source vs configuration/data categories, test-code exclusion, and inventory counters across included, policy-excluded, size-limited, max-file-limited, failed, and unvisited files.
- [ ] Run the focused tests and confirm they fail on current behavior.
- [ ] Add file categories and retain configuration/manifest/data files in the inventory without aggregating them as source languages or source-code size/lines.
- [ ] Define counters for discovered, included, analyzed, excluded, skipped, failed files, and excluded/failed directories. Keep legacy aliases only with documented definitions.
- [ ] Distinguish encountered files from unvisited files after a traversal limit.
- [ ] Mark policy exclusions as disclosed but non-partial; limits, traversal/read failures, cancellation, and failed requested analysis make the scan partial.
- [ ] Verify source/config separation and all counter relationships with focused tests.

## Task 2: Analyzer Execution Contract and Cancellation

**Files:** `src/analyzers/analyzer-registry.js`, `src/scanner.js`, `src/reporting/report-builder.js`, analyzer registry/scanner tests.

- [ ] Add failing tests for invalid IDs/versions, dependency order, duplicate IDs, missing prerequisites, thrown failures, unsupported/skipped/cancelled states, unsafe output, and execution isolation between runs.
- [ ] Add validated analyzer metadata, optional prerequisite IDs, safe JSON-result validation, per-run execution states, and registered versions.
- [ ] Skip downstream analyzers when requested prerequisites fail; preserve successful independent results.
- [ ] Propagate cancellation and record unexecuted analyzers explicitly.
- [ ] Add report execution summaries and verify registry/scanner behavior.

## Task 3: Static .NET Metadata and Dependency Analysis

**Files:** create `src/analyzers/dotnet-analyzer.js` and shared safe XML helpers as needed; modify dependency/classifier/registry/report code; add analyzer fixtures.

- [ ] Add failing tests for differing package and target versions, multiple and conditional TFMs, framework references, `global.json`, central package management, package properties, project references, solution membership, and lock resolution.
- [ ] Parse `.sln`, `.slnx`, project files, `Directory.Build.props`/`.targets`, `Directory.Packages.props`, `global.json`, and `packages.lock.json` using safe XML/JSON parsing only.
- [ ] Record raw conditions, property expressions, evidence paths, and version sources. Do not evaluate conditions or imported build logic.
- [ ] Report declared and resolved versions separately. Use lockfile resolved versions only for a matching direct package entry; otherwise mark the declaration unresolved.
- [ ] Preserve current direct .NET `PackageReference` extraction, including `Include` and `Update`.
- [ ] Verify two-project synthetic fixture behavior and safe handling of malformed manifests.

## Task 4: Stable Project Relationships and Technology Evidence

**Files:** `src/repository/project-detector.js`, `src/analyzers/technology-analyzer.js`, report builder, project/technology tests.

- [ ] Add failing tests for stable IDs, same-ecosystem projects in different directories, lockfile association, solution membership, and project references.
- [ ] Give project records deterministic opaque IDs and associate solution/project references by normalized repository-relative paths.
- [ ] Add a normalized technology model with stable IDs, category, method, evidence type/path, confidence, analyzer version, and explicit package-version scope.
- [ ] Emit target framework and SDK constraints as separate project metadata. Do not emit runtime-version claims without runtime evidence.
- [ ] Deduplicate findings by technology ID plus evidence identity and verify contradictory versions remain scoped to their projects.

## Task 5: Versioned Report Schema and Semantic Validation

**Files:** create `schemas/report-2.0.schema.json`; modify `src/reporting/json-reporter.js`, `src/reporting/report-builder.js`, package manifest/lockfile, reporting tests.

- [ ] Add failing tests for malformed required fields, status/completeness mismatch, invalid timestamps/order, negative counters, inconsistent counts, and dangling evidence references.
- [ ] Pin Ajv and `ajv-formats`; compile the schema once and validate every serialized report.
- [ ] Define strict report v2 object shapes, controlled enums, counter fields, dependency version states, analyzer states, and technology/project evidence structures.
- [ ] Add semantic checks for timestamp order, counter bounds/aliases, `files.length`, status/completeness, and report-local evidence references.
- [ ] Verify valid and invalid hand-built reports plus all scanner-produced reports.

## Task 6: Synthetic .NET Fixture, Sample Report, Documentation, and Final Audit

**Files:** create `examples/dotnet-sample/`, `examples/dotnet-report.json`, update `README.md`, add end-to-end tests.

- [ ] Build a synthetic two-project solution with different target frameworks, a conditional TFM, central package versions, unresolved properties, project references, `global.json`, a direct lockfile version, and the misleading ASP.NET package version case.
- [ ] Add end-to-end assertions for the report counters, eight declared dependency records, source/config metrics, schema, evidence references, and absence of runtime inference.
- [ ] Generate the JSON report by running the CLI against the synthetic fixture; label it synthetic because no supplied .NET repository/report exists in the workspace.
- [ ] Document counter definitions, category/source metric rules, analyzer statuses, schema v2, .NET limitations, privacy scope, and verified commands.
- [ ] Run focused tests, full `npm test`, the sample .NET scan, and report validation. Inspect all output before claiming completion.

