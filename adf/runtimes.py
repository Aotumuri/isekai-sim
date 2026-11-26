"""Offline interpreter choices for App Server's isolated command runner."""

from functools import lru_cache
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import sys

from .snapshots import metadata

NODE = (Path("/opt/homebrew/opt/node@24/bin/node"), Path("/opt/homebrew/bin/node"))
CELLAR = Path("/opt/homebrew/Cellar")


def node_binary():
    return next((path.resolve() for path in NODE if path.is_file()), NODE[-1].resolve())


def node_installation():
    binary = node_binary()
    key = tuple(metadata(binary.stat()))
    result = inspect_node(binary, key)
    for library in result[1].values():
        package = library.relative_to(CELLAR).parts[0]
        alias = Path("/opt/homebrew/opt") / package
        if alias.exists() and not library.is_relative_to(alias.resolve()):
            inspect_node.cache_clear()
            return inspect_node(binary, key)
    return result


@lru_cache(maxsize=4)
def inspect_node(binary, binary_metadata):
    if not binary.is_file() or not binary.is_relative_to(CELLAR):
        raise ValueError("Homebrew Node を利用できません")
    seen = set()
    libraries = {}
    todo = [binary]
    while todo:
        current = todo.pop()
        if current in seen:
            continue
        seen.add(current)
        data = subprocess.run(["/usr/bin/otool", "-L", str(current)], check=True,
                              capture_output=True, text=True, timeout=3).stdout
        for line in data.splitlines()[1:]:
            link = line.strip().split(" (compatibility", 1)[0]
            if link.startswith("@rpath/"):
                candidates = (current.parent / Path(link).name, binary.parent.parent / "lib" / Path(link).name)
                path = next((item for item in candidates if item.is_file()), candidates[-1])
            elif link.startswith("@loader_path/"):
                path = current.parent / link.removeprefix("@loader_path/")
            elif link.startswith("/opt/homebrew/"):
                path = Path(link)
            else:
                continue
            path = path.resolve()
            if not path.is_relative_to(CELLAR) or not path.is_file():
                raise ValueError("Node の依存ライブラリを固定できません")
            library = Path(link).name
            if library in libraries and libraries[library] != path:
                raise ValueError("複数の Node ライブラリが同じ名前を使用しています")
            libraries[library] = path
            todo.append(path)
    return binary, libraries


def runtime_files(kind):
    if kind == "node":
        return ()
    return (Path(sys.executable).resolve(), Path(sys.base_prefix).resolve())


def runtime_name(kind):
    return "adf-node" if kind == "node" else "adf-experiment"


def runtime_command(kind, program, script, dependencies):
    if kind == "node":
        node_installation()
        return ["/bin/sh", "-c", 'export DYLD_LIBRARY_PATH="$PWD/.adf-node/lib" OPENSSL_CONF=/dev/null; exec "$@"',
                "adf-node", "./.adf-node/bin/node", "--no-warnings", "--max-old-space-size=256",
                *([f"./{script}"] if script else ["--eval", program])]
    binary = str(runtime_files("python")[0])
    bootstrap = "import sys, runpy; "
    if dependencies:
        bootstrap += "sys.path.insert(0, '.adf-site'); "
    bootstrap += "sys.path.insert(0, '.'); "
    bootstrap += f"runpy.run_path({script!r}, run_name='__main__')" if script else program
    return [binary, "-I", "-B", "-S", "-c", bootstrap]


def file_sha(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def prepare_node(source):
    binary, libraries = node_installation()
    stored = source.parent / "input/node"
    files = {"bin/node": binary, **{f"lib/{name}": path for name, path in libraries.items()}}
    if sum(path.stat().st_size for path in files.values()) > 256 * 1024**2:
        raise ValueError("Node インストール済み依存の容量が上限を超えました")
    metadata = {}
    for name, path in files.items():
        target = stored / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        target.chmod(0o700 if name == "bin/node" else 0o600)
        metadata[name] = file_sha(target)
    shutil.copytree(stored, source / ".adf-node")
    version = next((part for part in binary.parts if re.fullmatch(r"\d+\.\d+\.\d+.*", part)), None)
    return {"kind": "node", "version": version, "interpreter": str(binary), "files": metadata}


def runtime_identity(kind):
    if kind != "python":
        raise ValueError("Node の再現情報は分離コピーから生成してください")
    binary = runtime_files(kind)[0]
    return {"kind": kind, "version": sys.version.split()[0], "interpreter": str(binary), "sha256": file_sha(binary)}


def runtime_stamp(kind):
    if kind == "python":
        binary, root = runtime_files(kind)
        paths = [binary, root, root / "Python"]
    else:
        binary, files = node_installation()
        paths = [binary, *files.values()]
        # Homebrew resolves a library through its opt alias, which can switch
        # versions while a process still retains an older Cellar path.
        paths.extend(Path("/opt/homebrew/opt") / path.relative_to(CELLAR).parts[0]
                     for path in files.values())
    return {str(path): metadata(path.stat()) if path.exists() else None for path in sorted(set(paths))}


def experiment_command(kind, program, script, dependencies, timeout):
    command = runtime_command(kind, program, script, dependencies)
    return ["/bin/sh", "-c", 'ulimit -f 32768 && ulimit -t "$1" && shift && exec "$@"',
            "adf-experiment", str(timeout), *command]
