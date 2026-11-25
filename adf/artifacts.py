"""Bounded access to result files without following experiment-controlled links."""

import os
from pathlib import PurePosixPath
import stat

ARTIFACTS = ".adf-artifacts"
MAX_READ = 64 * 1024


def read_result(root, name, offset=0, size=4096):
    if not isinstance(name, str) or not 0 < len(name) <= 512 or "\0" in name:
        raise ValueError("成果物の相対パスを指定してください")
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts or len(path.parts) > 12:
        raise ValueError("成果物の相対パスを指定してください")
    if type(offset) is not int or not 0 <= offset <= 2**40 or type(size) is not int or not 1 <= size <= MAX_READ:
        raise ValueError("成果物の読み取り範囲が不正です")
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, dir_flags)
    try:
        for part in path.parts[:-1]:
            next_fd = os.open(part, dir_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        item = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(item, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("成果物は通常ファイルに限ります")
            handle.seek(offset)
            data = handle.read(size)
        return {"text": data.decode(errors="replace"), "offset": offset,
                "next": offset + len(data), "total": info.st_size}
    finally:
        os.close(fd)


def list_results(root):
    try:
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return []
    results = []
    try:
        with os.scandir(fd) as entries:
            for index, entry in enumerate(entries):
                if index >= 200:
                    break
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    results.append({"name": entry.name, "bytes": info.st_size})
    finally:
        os.close(fd)
    return sorted(results, key=lambda item: item["name"])
