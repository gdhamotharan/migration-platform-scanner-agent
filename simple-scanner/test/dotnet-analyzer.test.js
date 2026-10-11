import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { classifyFile } from '../src/repository/file-classifier.js';
import { DotnetAnalyzer } from '../src/analyzers/dotnet-analyzer.js';

async function fixture(t, files) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'scanner-dotnet-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const entries = [];
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(rootPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
    entries.push({ ...classifyFile(relativePath), relativePath, absolutePath, sizeBytes: Buffer.byteLength(contents) });
  }
  return { rootPath, entries };
}

test('dotnet metadata keeps package versions separate from target frameworks and runtime', async (t) => {
  const { rootPath, entries } = await fixture(t, {
    'global.json': '{"sdk":{"version":"8.0.200","rollForward":"latestFeature"}}',
    'App.csproj': '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="8.0.11"/></ItemGroup></Project>'
  });
  const result = await new DotnetAnalyzer().analyze({ rootPath, files: entries, options: {} });
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].target_frameworks[0].declared_value, 'net8.0');
  assert.equal(result.projects[0].runtime.status, 'not_detected');
  assert.equal(result.dependencies[0].declared_version, '8.0.11');
  assert.equal(result.dependencies[0].resolved_version, null);
  assert.equal(result.sdk_constraints[0].declared_version, '8.0.200');
  assert.equal(result.sdk_constraints[0].roll_forward, 'latestFeature');
});

test('dotnet analyzer preserves conditional and property based target frameworks and central package versions', async (t) => {
  const { rootPath, entries } = await fixture(t, {
    'Directory.Packages.props': '<Project><ItemGroup><PackageVersion Include="Serilog" Version="$(LoggingVersion)"/><PackageVersion Include="Newtonsoft.Json" Version="13.0.3"/></ItemGroup></Project>',
    'src/A.csproj': '<Project><PropertyGroup Condition="\'$(Configuration)\' == \'Debug\'"><TargetFramework>net8.0</TargetFramework></PropertyGroup><PropertyGroup Condition="\'$(Configuration)\' == \'Release\'"><TargetFrameworks>net8.0;net9.0</TargetFrameworks></PropertyGroup><ItemGroup><PackageReference Include="Serilog"/><PackageReference Update="Newtonsoft.Json"/><PackageReference Include="Conditional" Version="$(ConditionalVersion)" Condition="\'$(OS)\' == \'Windows_NT\'"/><ProjectReference Include="B/B.csproj"/></ItemGroup></Project>',
    'src/B/B.csproj': '<Project><PropertyGroup><TargetFramework>netstandard2.1</TargetFramework></PropertyGroup></Project>',
    'App.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00\r\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "src\\A.csproj", "{11111111-1111-1111-1111-111111111111}"\r\nEndProject\r\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "B", "src\\B\\B.csproj", "{22222222-2222-2222-2222-222222222222}"\r\nEndProject'
  });
  const result = await new DotnetAnalyzer().analyze({ rootPath, files: entries, options: {} });
  const projectA = result.projects.find((item) => item.manifest_path === 'src/A.csproj');
  const serilog = result.dependencies.find((item) => item.name === 'Serilog');
  const newtonsoft = result.dependencies.find((item) => item.name === 'Newtonsoft.Json');
  const conditional = result.dependencies.find((item) => item.name === 'Conditional');
  assert.deepEqual(projectA.target_frameworks.map((item) => item.declared_value), ['net8.0', 'net8.0;net9.0']);
  assert.ok(projectA.target_frameworks.every((item) => item.condition));
  assert.equal(serilog.declared_version, '$(LoggingVersion)');
  assert.equal(serilog.version_source, 'central_package_management');
  assert.equal(serilog.version_status, 'unresolved');
  assert.equal(newtonsoft.declared_version, '13.0.3');
  assert.equal(newtonsoft.version_source, 'central_package_management');
  assert.equal(newtonsoft.version_status, 'declared');
  assert.equal(conditional.condition.includes('Windows_NT'), true);
  assert.equal(conditional.version_status, 'unresolved');
  assert.equal(projectA.project_references[0].target_path, 'src/B/B.csproj');
  assert.deepEqual(result.solution_memberships.map((item) => item.project_path).sort(), ['src/A.csproj', 'src/B/B.csproj']);
});

test('dotnet analyzer uses matching direct lockfile entries and isolates malformed metadata', async (t) => {
  const { rootPath, entries } = await fixture(t, {
    'App.csproj': '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3"/><PackageReference Include="Serilog" Version="$(SerilogVersion)"/><PackageReference Include="Mismatch" Version="1.0.0"/></ItemGroup></Project>',
    'packages.lock.json': JSON.stringify({ version: 1, dependencies: { 'net8.0': {
      'Newtonsoft.Json': { type: 'Direct', requested: '[13.0.3, )', resolved: '13.0.3' },
      'Serilog': { type: 'Direct', requested: '[2.12.0, )', resolved: '2.12.0' },
      'Mismatch': { type: 'Direct', requested: '[2.0.0, )', resolved: '2.0.0' }
    } } })
  });
  const result = await new DotnetAnalyzer().analyze({ rootPath, files: entries, options: {} });
  assert.equal(result.dependencies.find((item) => item.name === 'Newtonsoft.Json').resolved_version, '13.0.3');
  assert.equal(result.dependencies.find((item) => item.name === 'Serilog').resolved_version, null);
  assert.equal(result.dependencies.find((item) => item.name === 'Serilog').version_status, 'unresolved');
  assert.equal(result.dependencies.find((item) => item.name === 'Mismatch').resolved_version, null);
  assert.equal(result.dependencies.find((item) => item.name === 'Mismatch').version_status, 'declared');
});

test('dotnet analyzer reads literal repository-local props imports without evaluating conditions', async (t) => {
  const { rootPath, entries } = await fixture(t, {
    'App.csproj': '<Project><Import Project="build/Shared.props" Condition="Exists(\'build/Shared.props\')"/></Project>',
    'build/Shared.props': '<Project><PropertyGroup><TargetFramework>net7.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Serilog" Version="3.1.0"/></ItemGroup></Project>'
  });
  const result = await new DotnetAnalyzer().analyze({ rootPath, files: entries, options: {} });
  assert.equal(result.projects[0].target_frameworks[0].declared_value, 'net7.0');
  assert.equal(result.projects[0].target_frameworks[0].evidence_file_path, 'build/Shared.props');
  assert.equal(result.dependencies[0].name, 'Serilog');
  assert.equal(result.dependencies[0].manifest_path, 'build/Shared.props');
  assert.equal(result.dependencies[0].condition.includes('Exists'), true);
  assert.equal(result.dependencies[0].version_status, 'unresolved');
});

test('malformed .NET metadata reports safe diagnostics without echoing contents', async (t) => {
  const secret = 'PRIVATE_MARKER_771992';
  const { rootPath, entries } = await fixture(t, {
    'Bad.csproj': `<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></Project>${secret}`
  });
  const result = await new DotnetAnalyzer().analyze({ rootPath, files: entries, options: {} });
  assert.equal(result.incomplete, true);
  assert.ok(result.file_errors.some((item) => item.path === 'Bad.csproj'));
  assert.equal(JSON.stringify(result).includes(secret), false);
});
