// VibePhi Android APK 构建脚本（无 Gradle，直接调用 build-tools 工具链）
// 用法: node tools/build-apk.mjs [--skip-build] [--version-code N] [--out DIR]
// 依赖: E:/android-build 下的 jdk-17*、android-14(build-tools)、android-34(platform)
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const shell = join(root, 'android-shell');
const buildDir = join(shell, 'build');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const versionCodeIdx = args.indexOf('--version-code');
const outIdx = args.indexOf('--out');

// ---------- 工具链定位 ----------
const toolsRoot = process.env.ANDROID_BUILD_TOOLS || 'E:/android-build';
const jdkDir = readdirSyncSafe(toolsRoot).find(n => /^jdk-17/.test(n));
if (!jdkDir) throw new Error(`找不到 JDK 17（在 ${toolsRoot} 下）`);
const javaBin = join(toolsRoot, jdkDir, 'bin');
const btDir = existsSync(join(toolsRoot, 'android-14')) ? join(toolsRoot, 'android-14') : null;
if (!btDir) throw new Error('找不到 build-tools 目录 android-14');
const androidJar = join(toolsRoot, 'android-34', 'android.jar');
if (!existsSync(androidJar)) throw new Error(`找不到 android.jar: ${androidJar}`);

const aapt2 = join(btDir, 'aapt2.exe');
const d8 = join(btDir, 'd8.bat');
const zipalign = join(btDir, 'zipalign.exe');
const apksigner = join(btDir, 'apksigner.bat');
const env = { ...process.env, JAVA_HOME: join(toolsRoot, jdkDir), PATH: `${javaBin};${process.env.PATH}` };

const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const versionName = metadata.version || '0.0.0';
const versionCode = versionCodeIdx >= 0 ? Number(args[versionCodeIdx + 1]) : 1;
const outDir = outIdx >= 0 ? args[outIdx + 1] : join(root, 'dist-apk');

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  // .bat 需要 shell；.exe 关闭 shell 以避免带空格参数（如 -dname）被拆散
  const useShell = opts.shell ?? cmd.toLowerCase().endsWith('.bat');
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env, shell: useShell, cwd: root, ...opts, shell: useShell });
  if (r.status !== 0) throw new Error(`命令失败 (exit ${r.status}): ${cmd}`);
}

function readdirSyncSafe(p) {
  try { return readdirSync(p); } catch { return []; }
}

// ---------- 1. Web 构建产物 ----------
if (!skipBuild) {
  run('node', ['tools/build.mjs']);
}
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/index.html 不存在，先运行 npm run build');

const www = join(shell, 'assets', 'www');
await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });
for (const name of await readdir(dist)) {
  if (['tools', 'package.json', 'start.cmd', 'README.md'].includes(name)) continue;
  await cp(join(dist, name), join(www, name), { recursive: true });
}
console.log('✓ dist → android-shell/assets/www');

// ---------- 2. 资源编译与链接 ----------
await rm(buildDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });
const resZip = join(buildDir, 'res.zip');
run(aapt2, ['compile', '--dir', join(shell, 'res'), '-o', resZip]);
const baseApk = join(buildDir, 'base.apk');
run(aapt2, [
  'link', '-o', baseApk,
  '-I', androidJar,
  '--manifest', join(shell, 'AndroidManifest.xml'),
  '-R', resZip,
  '--min-sdk-version', '29',
  '--target-sdk-version', '34',
  '--version-code', String(versionCode),
  '--version-name', versionName,
  '--auto-add-overlay',
]);
// 注意：assets 不走 aapt2 -A（Windows aapt2 处理中文文件名会失败），
// 由 apk-add-dex.py 直接写入 APK（assets 无需编译）。

// ---------- 3. Java 编译与 dex ----------
const classesDir = join(buildDir, 'classes');
await mkdir(classesDir, { recursive: true });
const javaSources = [];
await collectJava(join(shell, 'java'), javaSources);
run(join(javaBin, 'javac.exe'), [
  '-classpath', androidJar,
  '-d', classesDir,
  '-encoding', 'UTF-8',
  '-source', '8', '-target', '8',
  '-Xlint:-options',
  ...javaSources,
]);
const dexDir = join(buildDir, 'dex');
await mkdir(dexDir, { recursive: true });
const classFiles = [];
await collectClassFiles(classesDir, classFiles);
run(d8, ['--release', '--lib', androidJar, '--min-api', '29', '--output', dexDir, ...classFiles]);

async function collectJava(dir, out) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) await collectJava(p, out);
    else if (name.name.endsWith('.java')) out.push(p);
  }
}

async function collectClassFiles(dir, out) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) await collectClassFiles(p, out);
    else if (name.name.endsWith('.class')) out.push(p);
  }
}

// ---------- 4. dex 注入 + 对齐 + 签名 ----------
const unsignedApk = join(buildDir, 'unsigned.apk');
run('python', [join(root, 'tools', 'apk-add-dex.py'), baseApk, join(dexDir, 'classes.dex'), join(shell, 'assets'), unsignedApk]);
const alignedApk = join(buildDir, 'aligned.apk');
run(zipalign, ['-f', '4', unsignedApk, alignedApk]);

// keystore：不存在则生成（长期密钥，升级覆盖安装必须同一签名）
const ksDir = join(shell, 'keystore');
await mkdir(ksDir, { recursive: true });
const keystore = join(ksDir, 'vibephi-release.keystore');
if (!existsSync(keystore)) {
  run(join(javaBin, 'keytool.exe'), [
    '-genkeypair', '-keystore', keystore, '-alias', 'vibephi',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
    '-storepass', 'vibephi2026', '-keypass', 'vibephi2026',
    '-dname', 'CN=VibePhi, OU=VibePhi, O=yexiwen289, L=Internet, C=CN',
  ]);
  console.log('✓ 已生成正式签名密钥 keystore/vibephi-release.keystore');
}
await mkdir(outDir, { recursive: true });
const apkOut = join(outDir, `VibePhi-${versionName}-mobile.apk`);
run(apksigner, [
  'sign', '--ks', keystore,
  '--ks-pass', 'pass:vibephi2026', '--key-pass', 'pass:vibephi2026',
  '--out', apkOut, alignedApk,
]);
run(apksigner, ['verify', '--print-certs', apkOut]);
console.log(`\n✓ APK 生成完成: ${apkOut}`);
