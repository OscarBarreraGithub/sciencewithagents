#!/usr/bin/env python3
"""Read a bounded literal report closure. No compiler, tools, network or account access."""
import base64
import json
import os
import pathlib
import posixpath
import re
import stat
import sys

MAX_BYTES, MAX_FILES = 8 * 1024**2, 100
NAME = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_./-]{0,239}\Z")


def name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value) or any(
        not part or part.startswith(".") for part in value.split("/")
    ):
        raise ValueError("invalid resource name")
    return value


def directory(value):
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("absolute owner workspace required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in value.split("/")[1:]:
            if not part or part in (".", ".."):
                raise ValueError("invalid workspace")
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return os.dup(fd)
    finally:
        os.close(fd)


def read(root, value):
    parts = name(value).split("/")
    fd = os.dup(root)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(source)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_BYTES:
                raise ValueError("bounded regular file required")
            with os.fdopen(os.dup(source), "rb") as stream:
                data = stream.read(MAX_BYTES + 1)
            after = os.fstat(source)
            if len(data) > MAX_BYTES or (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns
            ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("input changed during capture")
            return data
        finally:
            os.close(source)
    finally:
        os.close(fd)


def collect(request):
    names = request["names"]
    if not isinstance(names, list) or not names or len(names) > MAX_FILES:
        raise ValueError("bounded exact inputs required")
    root = directory(request["workspace"])
    try:
        identity = request.get("identity")
        root_stat = os.fstat(root)
        if identity is not None and identity != f"{root_stat.st_dev}:{root_stat.st_ino}":
            raise ValueError("workspace identity changed")
        files, pending = {}, list(names)
        while pending:
            resource = name(pending.pop())
            if resource in files:
                continue
            data = read(root, resource)
            files[resource] = data
            if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_BYTES:
                raise ValueError("input limit")
            if not resource.lower().endswith(".tex"):
                continue
            text = re.sub(r"(?<!\\)%[^\n]*", "", data.decode("utf-8", "strict"))
            for command, argument in re.findall(
                r"\\(input|include|includegraphics|addbibresource|bibliography)(?:\[[^\]\n]*\])?\s*\{([^{}]+)\}", text
            ):
                for part in argument.split(",") if command == "bibliography" else [argument]:
                    # Normalize literal parents only within this exact owner workspace.
                    candidate = name(posixpath.normpath(str(pathlib.PurePosixPath(resource).parent / part.strip())))
                    extensions = [""] if pathlib.PurePosixPath(candidate).suffix else (
                        [".png", ".jpg", ".jpeg", ".pdf", ".webp"] if command == "includegraphics"
                        else [".bib"] if command in ("bibliography", "addbibresource") else [".tex"]
                    )
                    selected = None
                    for extension in extensions:
                        try:
                            read(root, candidate + extension)
                            selected = candidate + extension
                            break
                        except FileNotFoundError:
                            pass
                    if selected is None:
                        raise ValueError("missing literal dependency")
                    pending.append(selected)
        # Recheck the entire closure, including inputs read before a later dependency.
        for resource, data in files.items():
            if read(root, resource) != data:
                raise ValueError("closure changed during capture")
        return {"files": [{"name": resource, "base64": base64.b64encode(data).decode("ascii")}
                          for resource, data in sorted(files.items())]}
    finally:
        os.close(root)


try:
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError("request limit")
    print(json.dumps(collect(json.loads(raw))))
except Exception:
    # Never return absolute paths, source bytes or exception details on denial.
    print('{"state":"denied"}')
    sys.exit(1)
