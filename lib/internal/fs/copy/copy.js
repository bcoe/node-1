'use strict';

// This file is a modified version of the fs-extra's copy method
// modified in the following ways:
//
// - Use of the graceful-fs has been replaced with fs.
// - Helpers from stat.js have been inlined.
// - Formatting and style changes to match Node.js' linting rules.
// - Parameter validation has been added.

const console = require('console');
const { codes } = require('internal/errors');
const {
  ERR_FS_COPY_DIR_TO_NON_DIR,
  ERR_FS_COPY_EEXIST,
  ERR_FS_COPY_FIFO_PIPE,
  ERR_FS_COPY_NON_DIR_TO_DIR,
  ERR_FS_COPY_SOCKET,
  ERR_FS_COPY_SYMLINK_TO_SUBDIRECTORY,
  ERR_FS_COPY_TO_SUBDIRECTORY,
  ERR_FS_COPY_UNKNOWN,
} = codes;
const {
  os: {
    errno: {
      EEXIST,
      EISDIR,
      EINVAL,
      ENOTDIR,
    }
  }
} = internalBinding('constants');
const fs = require('fs');
const {
  chmod,
  close,
  copyFile,
  futimes,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  stat,
  symlink,
  unlink,
} = fs;
const path = require('path');
const {
  dirname,
  join,
  parse,
  resolve,
  sep,
} = path;
const { Promise, PromiseAll, PromiseResolve } = primordials;
const util = require('util');
const {
  callbackify,
  promisify,
} = util;
const statAsync = promisify(stat);
const lstatAsync = promisify(lstat);

function copyFn(src, dest, opts, cb) {
  // Warn about using preserveTimestamps on 32-bit node
  if (opts.preserveTimestamps && process.arch === 'ia32') {
    console.warn('Using the preserveTimestamps option in 32-bit' +
      'node is not recommended; see' +
      'https://github.com/jprichardson/node-fs-extra/issues/269'
    );
  }

  checkPaths(src, dest, opts, (err, stats) => {
    if (err) return cb(err);
    const { srcStat, destStat } = stats;
    checkParentPaths(src, srcStat, dest, (err) => {
      if (err) return cb(err);
      if (opts.filter) {
        return handleFilter(checkParentDir, destStat, src, dest, opts, cb);
      }
      return checkParentDir(destStat, src, dest, opts, cb);
    });
  });
}

function checkPaths(src, dest, opts, cb) {
  getStats(src, dest, opts, (err, stats) => {
    if (err) return cb(err);
    const { srcStat, destStat } = stats;
    if (destStat) {
      if (areIdentical(srcStat, destStat)) {
        return cb(new ERR_FS_COPY_TO_SUBDIRECTORY({
          code: 'EINVAL',
          message: 'src and dest cannot be the same directory',
          path: dest,
          syscall: 'copy',
          errno: EINVAL,
        }));
      }
      if (srcStat.isDirectory() && !destStat.isDirectory()) {
        return cb(new ERR_FS_COPY_DIR_TO_NON_DIR({
          code: 'EISDIR',
          message: `cannot overwrite directory ${src} ` +
            `with non-directory ${dest}`,
          path: dest,
          syscall: 'copy',
          errno: EISDIR,
        }));
      }
      if (!srcStat.isDirectory() && destStat.isDirectory()) {
        return cb(new ERR_FS_COPY_NON_DIR_TO_DIR({
          code: 'ENOTDIR',
          message: `cannot overwrite non-directory ${src} ` +
            `with directory ${dest}`,
          path: dest,
          syscall: 'copy',
          errno: ENOTDIR,
        }));
      }
    }

    if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
      return cb(new ERR_FS_COPY_TO_SUBDIRECTORY({
        code: 'EINVAL',
        message: `cannot copy ${src} to a subdirectory of self ${dest}`,
        path: dest,
        syscall: 'copy',
        errno: EINVAL,
      }));
    }
    return cb(null, { srcStat, destStat });
  });
}

function areIdentical(srcStat, destStat) {
  return destStat.ino && destStat.dev && destStat.ino === srcStat.ino &&
    destStat.dev === srcStat.dev;
}

function getStatsAsync(src, dest, opts) {
  const statFunc = opts.dereference ?
    (file) => statAsync(file, { bigint: true }) :
    (file) => lstatAsync(file, { bigint: true });
  return PromiseAll([
    statFunc(src),
    statFunc(dest).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }),
  ]).then(({ 0: srcStat, 1: destStat }) => ({ srcStat, destStat }));
}
const getStats = callbackify(getStatsAsync);

function checkParentDir(destStat, src, dest, opts, cb) {
  const destParent = dirname(dest);
  pathExists(destParent, (err, dirExists) => {
    if (err) return cb(err);
    if (dirExists) return getStatsForCopy(destStat, src, dest, opts, cb);
    mkdir(destParent, { recursive: true }, (err) => {
      if (err) return cb(err);
      return getStatsForCopy(destStat, src, dest, opts, cb);
    });
  });
}

function pathExists(dest, cb) {
  stat(dest, (err, stat) => {
    if (err) {
      if (err.code === 'ENOENT') return cb(null, false);
      return cb(err);
    }
    return cb(null, true);

  });
}

// Recursively check if dest parent is a subdirectory of src.
// It works for all file types including symlinks since it
// checks the src and dest inodes. It starts from the deepest
// parent and stops once it reaches the src parent or the root path.
function checkParentPaths(src, srcStat, dest, cb) {
  const srcParent = resolve(dirname(src));
  const destParent = resolve(dirname(dest));
  if (destParent === srcParent || destParent === parse(destParent).root) {
    return cb(null);
  }
  stat(destParent, { bigint: true }, (err, destStat) => {
    if (err) {
      if (err.code === 'ENOENT') return cb(null);
      return cb(err);
    }
    if (areIdentical(srcStat, destStat)) {
      return cb(new ERR_FS_COPY_TO_SUBDIRECTORY({
        code: 'EINVAL',
        message: `cannot copy ${src} to a subdirectory of self ${dest}`,
        path: dest,
        syscall: 'copy',
        errno: EINVAL,
      }));
    }
    return checkParentPaths(src, srcStat, destParent, cb);
  });
}

// Return true if dest is a subdir of src, otherwise false.
// It only checks the path strings.
function isSrcSubdir(src, dest) {
  const srcArr = resolve(src).split(sep).filter((i) => i);
  const destArr = resolve(dest).split(sep).filter((i) => i);
  return srcArr.reduce((acc, cur, i) => acc && destArr[i] === cur, true);
}

function handleFilter(onInclude, destStat, src, dest, opts, cb) {
  PromiseResolve(opts.filter(src, dest)).then((include) => {
    if (include) return onInclude(destStat, src, dest, opts, cb);
    return cb(null);
  }, (error) => cb(error));
}

function startCopy(destStat, src, dest, opts, cb) {
  if (opts.filter) {
    return handleFilter(getStatsForCopy, destStat, src, dest, opts, cb);
  }
  return getStatsForCopy(destStat, src, dest, opts, cb);
}

function getStatsForCopy(destStat, src, dest, opts, cb) {
  const statFn = opts.dereference ? stat : lstat;
  statFn(src, (err, srcStat) => {
    if (err) return cb(err);

    if (srcStat.isDirectory()) {
      return onDir(srcStat, destStat, src, dest, opts, cb);
    } else if (srcStat.isFile() ||
             srcStat.isCharacterDevice() ||
             srcStat.isBlockDevice()) {
      return onFile(srcStat, destStat, src, dest, opts, cb);
    } else if (srcStat.isSymbolicLink()) {
      return onLink(destStat, src, dest, opts, cb);
    } else if (srcStat.isSocket()) {
      return cb(new ERR_FS_COPY_SOCKET({
        code: 'EINVAL',
        message: `cannot copy a socket file: ${dest}`,
        path: dest,
        syscall: 'copy',
        errno: EINVAL,
      }));
    } else if (srcStat.isFIFO()) {
      return cb(new ERR_FS_COPY_FIFO_PIPE({
        code: 'EINVAL',
        message: `cannot copy a FIFO pipe: ${dest}`,
        path: dest,
        syscall: 'copy',
        errno: EINVAL,
      }));
    }
    return cb(new ERR_FS_COPY_UNKNOWN({
      code: 'EINVAL',
      message: `cannot copy a unknown file type: ${dest}`,
      path: dest,
      syscall: 'copy',
      errno: EINVAL,
    }));
  });
}

function onFile(srcStat, destStat, src, dest, opts, cb) {
  if (!destStat) return _copyFile(srcStat, src, dest, opts, cb);
  return mayCopyFile(srcStat, src, dest, opts, cb);
}

function mayCopyFile(srcStat, src, dest, opts, cb) {
  if (opts.overwrite) {
    unlink(dest, (err) => {
      if (err) return cb(err);
      return _copyFile(srcStat, src, dest, opts, cb);
    });
  } else if (opts.errorOnExist) {
    return cb(new ERR_FS_COPY_EEXIST({
      code: 'EEXIST',
      message: `${dest} already exists`,
      path: dest,
      syscall: 'copy',
      errno: EEXIST,
    }));
  } else return cb(null);
}

function _copyFile(srcStat, src, dest, opts, cb) {
  copyFile(src, dest, (err) => {
    if (err) return cb(err);
    if (opts.preserveTimestamps) {
      return handleTimestampsAndMode(srcStat.mode, src, dest, cb);
    }
    return setDestMode(dest, srcStat.mode, cb);
  });
}

function handleTimestampsAndMode(srcMode, src, dest, cb) {
  // Make sure the file is writable before setting the timestamp
  // otherwise open fails with EPERM when invoked with 'r+'
  // (through utimes call)
  if (fileIsNotWritable(srcMode)) {
    return makeFileWritable(dest, srcMode, (err) => {
      if (err) return cb(err);
      return setDestTimestampsAndMode(srcMode, src, dest, cb);
    });
  }
  return setDestTimestampsAndMode(srcMode, src, dest, cb);
}

function fileIsNotWritable(srcMode) {
  return (srcMode & 0o200) === 0;
}

function makeFileWritable(dest, srcMode, cb) {
  return setDestMode(dest, srcMode | 0o200, cb);
}

function setDestTimestampsAndMode(srcMode, src, dest, cb) {
  setDestTimestamps(src, dest, (err) => {
    if (err) return cb(err);
    return setDestMode(dest, srcMode, cb);
  });
}

function setDestMode(dest, srcMode, cb) {
  return chmod(dest, srcMode, cb);
}

function setDestTimestamps(src, dest, cb) {
  // The initial srcStat.atime cannot be trusted
  // because it is modified by the read(2) system call
  // (See https://nodejs.org/api/fs.html#fs_stat_time_values)
  stat(src, (err, updatedSrcStat) => {
    if (err) return cb(err);
    return utimesMillis(dest, updatedSrcStat.atime, updatedSrcStat.mtime, cb);
  });
}

function utimesMillis(path, atime, mtime, callback) {
  open(path, 'r+', (err, fd) => {
    if (err) return callback(err);
    futimes(fd, atime, mtime, (futimesErr) => {
      close(fd, (closeErr) => {
        if (callback) callback(futimesErr || closeErr);
      });
    });
  });
}

function onDir(srcStat, destStat, src, dest, opts, cb) {
  if (!destStat) return mkDirAndCopy(srcStat.mode, src, dest, opts, cb);
  return copyDir(src, dest, opts, cb);
}

function mkDirAndCopy(srcMode, src, dest, opts, cb) {
  mkdir(dest, (err) => {
    if (err) return cb(err);
    copyDir(src, dest, opts, (err) => {
      if (err) return cb(err);
      return setDestMode(dest, srcMode, cb);
    });
  });
}

function copyDir(src, dest, opts, cb) {
  readdir(src, (err, items) => {
    if (err) return cb(err);
    return copyDirItems(items, src, dest, opts, cb);
  });
}

function copyDirItems(items, src, dest, opts, cb) {
  const item = items.pop();
  if (!item) return cb(null);
  return copyDirItem(items, item, src, dest, opts, cb);
}

function copyDirItem(items, item, src, dest, opts, cb) {
  const srcItem = join(src, item);
  const destItem = join(dest, item);
  checkPaths(srcItem, destItem, opts, (err, stats) => {
    if (err) return cb(err);
    const { destStat } = stats;
    startCopy(destStat, srcItem, destItem, opts, (err) => {
      if (err) return cb(err);
      return copyDirItems(items, src, dest, opts, cb);
    });
  });
}

function onLink(destStat, src, dest, opts, cb) {
  readlink(src, (err, resolvedSrc) => {
    if (err) return cb(err);
    // TODO(bcoe): I don't know how this could be called, because
    // getStatsForCopy will have used stat. Ask during review.
    if (opts.dereference) {
      resolvedSrc = resolve(process.cwd(), resolvedSrc);
    }

    if (!destStat) {
      return symlink(resolvedSrc, dest, cb);
    }
    readlink(dest, (err, resolvedDest) => {
      if (err) {
        // Dest exists and is a regular file or directory,
        // Windows may throw UNKNOWN error. If dest already exists,
        // fs throws error anyway, so no need to guard against it here.
        if (err.code === 'EINVAL' || err.code === 'UNKNOWN') {
          return symlink(resolvedSrc, dest, cb);
        }
        return cb(err);
      }
      if (opts.dereference) {
        resolvedDest = resolve(process.cwd(), resolvedDest);
      }
      if (isSrcSubdir(resolvedSrc, resolvedDest)) {
        return cb(new ERR_FS_COPY_TO_SUBDIRECTORY({
          code: 'EINVAL',
          message: `cannot copy ${resolvedSrc} to a subdirectory of self ` +
            `${resolvedDest}`,
          path: dest,
          syscall: 'copy',
          errno: EINVAL,
        }));
      }

      // Do not copy if src is a subdir of dest since unlinking
      // dest in this case would result in removing src contents
      // and therefore a broken symlink would be created.
      // TODO(bcoe): I'm having trouble exercising this code in test,
      // ask about during review.
      if (destStat.isDirectory() &&
          stat.isSrcSubdir(resolvedDest, resolvedSrc)) {
        return cb(new ERR_FS_COPY_SYMLINK_TO_SUBDIRECTORY({
          code: 'EINVAL',
          message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
          path: dest,
          syscall: 'copy',
          errno: EINVAL,
        }));
      }
      return copyLink(resolvedSrc, dest, cb);
    });
  });
}

function copyLink(resolvedSrc, dest, cb) {
  unlink(dest, (err) => {
    if (err) return cb(err);
    return symlink(resolvedSrc, dest, cb);
  });
}

function copyPromises(src, dest, options) {
  return new Promise((resolve, reject) => {
    copyFn(src, dest, options, (err) => {
      if (err)
        return reject(err);

      resolve();
    });
  });
}

module.exports = { areIdentical, copyFn, copyPromises, isSrcSubdir };
