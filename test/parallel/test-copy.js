'use strict';

const common = require('../common');
if (!common.hasCrypto) { common.skip('missing crypto'); }

const assert = require('assert');
const { randomUUID } = require('crypto');
const fs = require('fs');
const {
  copy,
  copySync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  statSync,
} = fs;
const net = require('net');
const { dirname, join } = require('path');

const isWindows = process.platform === 'win32';
const tmpdir = require('../common/tmpdir');
tmpdir.refresh();

let dirc = 0;
function nextdir() {
  return join(tmpdir.path, `copy_${++dirc}`);
}

// Async version of copy.

// It copies a nested folder structure with files, folders, symlinks.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = nextdir();
  copy(src, dest, common.mustCall((err) => {
    assert.strictEqual(err, null);
    assertDirEquivalent(src, dest);
  }));
}

// It throws error if existing symlink in dest is in subdirectory src.
// TODO(bcoe): this behavior seemed strange to me, ask about it in review.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = nextdir();
  copySync(src, dest);
  copy(src, dest, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_TO_SUBDIRECTORY');
    assertDirEquivalent(src, dest);
  }));
}

// It does not fail if the same directory is copied to dest twice,
// when dereference is true, and overwrite true.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = nextdir();
  const destFile = join(dest, 'a/b/README2.md');
  copySync(src, dest, {dereference: true});
  copy(src, dest, { dereference: true }, common.mustCall((err) => {
    assert.strictEqual(err, null);
    const stat = lstatSync(destFile);
    assert(stat.isFile());
  }));
}

// It copies file itself, rather than symlink, when dereference is true.
{
  const src = require.resolve('../fixtures/copy/kitchen-sink');
  const dest = nextdir();
  const destFile = join(dest, 'foo.js');
  copy(src, destFile, { dereference: true }, common.mustCall((err) => {
    assert.strictEqual(err, null);
    const stat = lstatSync(destFile);
    assert(stat.isFile());
  }));
}

// It returns error when src and dest are identical.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  copy(src, src, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_TO_SUBDIRECTORY');
  }));
}

// It returns error if part of dest path is symlink to src.
{
  const src = nextdir();
  mkdirSync(join(src, 'a'), { recursive: true });
  const dest = nextdir();
  // Create symlink in dest pointing to src.
  const destLink = join(dest, 'b');
  mkdirSync(dest, { recursive: true });
  symlinkSync(src, destLink);
  copy(src, join(dest, 'b', 'c'), common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_TO_SUBDIRECTORY');
  }));
}

// It returns error if attempt is made to copy directory to file.
{
  const src = nextdir();
  mkdirSync(src, { recursive: true });
  const dest = require.resolve('../fixtures/copy/kitchen-sink');
  copy(src, dest, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_DIR_TO_NON_DIR');
  }));
}

// It allows file to be copied to a file path.
{
  const srcFile = require.resolve('../fixtures/copy/kitchen-sink');
  const destFile = join(nextdir(), 'index.js');
  copy(srcFile, destFile, { dereference: true }, common.mustCall((err) => {
    assert.strictEqual(err, null);
    const stat = lstatSync(destFile);
    assert(stat.isFile());
  }));
}

// It returns error if attempt is made to copy file to directory.
{
  const src = require.resolve('../fixtures/copy/kitchen-sink');
  const dest = nextdir();
  mkdirSync(dest, { recursive: true });
  copy(src, dest, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_NON_DIR_TO_DIR');
  }));
}

// It returns error if attempt is made to copy to subdirectory of self.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = dirname(
    require.resolve('../fixtures/copy/kitchen-sink/a')
  );
  copy(src, dest, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_TO_SUBDIRECTORY');
  }));
}

// It returns an error if attempt is made to copy socket.
if (!isWindows) {
  const dest = nextdir();
  const sock = `${randomUUID()}.sock`;
  const server = net.createServer();
  server.listen(sock);
  copy(sock, dest, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_SOCKET');
    server.close();
  }));
}

// It copies timestamps from src to dest if preserveTimestamps is true.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = nextdir();
  copy(src, dest, { preserveTimestamps: true }, common.mustCall((err) => {
    assert.strictEqual(err, null);
    assertDirEquivalent(src, dest);
    const srcStat = lstatSync(join(src, 'index.js'));
    const destStat = lstatSync(join(dest, 'index.js'));
    assert.strictEqual(srcStat.mtime.getTime(), destStat.mtime.getTime());
  }));
}

// It applies filter function.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = nextdir();
  copy(src, dest, {
    filter: (path) => {
      const pathStat = statSync(path);
      return pathStat.isDirectory() || path.endsWith('.js');
    },
    dereference: true
  }, common.mustCall((err) => {
    assert.strictEqual(err, null);
    const destEntries = [];
    collectEntries(dest, destEntries);
    for (const entry of destEntries) {
      assert.strictEqual(
        entry.isDirectory() || entry.name.endsWith('.js'),
        true
      );
    }
  }));
}

// It returns error if errorOnExist is true, and file or folder copied over.
{
  const src = dirname(require.resolve('../fixtures/copy/kitchen-sink'));
  const dest = nextdir();
  copySync(src, dest);
  copy(src, dest, {
    dereference: true,
    overwrite: false,
    errorOnExist: true,
  }, common.mustCall((err) => {
    assert.strictEqual(err.code, 'ERR_FS_COPY_EEXIST');
  }));
}

function assertDirEquivalent(dir1, dir2) {
  const dir1Entries = [];
  collectEntries(dir1, dir1Entries);
  const dir2Entries = [];
  collectEntries(dir2, dir2Entries);
  assert.strictEqual(dir1Entries.length, dir2Entries.length);
  for (const entry1 of dir1Entries) {
    const entry2 = dir2Entries.find((entry) => {
      return entry.name === entry1.name;
    });
    assert(entry2, `entry ${entry2.name} not copied`);
    if (entry1.isFile()) {
      assert(entry2.isFile(), `${entry2.name} was not file`);
    } else if (entry1.isDirectory()) {
      assert(entry2.isDirectory(), `${entry2.name} was not directory`);
    } else if (entry1.isSymbolicLink()) {
      assert(entry2.isSymbolicLink(), `${entry2.name} was not symlink`);
    }
  }
}

function collectEntries(dir, dirEntries) {
  const newEntries = [...readdirSync(dir, { withFileTypes: true })];
  for (const entry of newEntries) {
    if (entry.isDirectory()) {
      collectEntries(join(dir, entry.name), dirEntries);
    }
  }
  dirEntries.push.apply(dirEntries, newEntries);
}
