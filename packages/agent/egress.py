"""Block new network access in the managed Linux workbench process."""
import ctypes
import errno
import sys
import threading


def restrict_egress():
    """Call after binding loopback and before starting request threads."""
    if sys.platform != "linux" or threading.active_count() != 1:
        raise RuntimeError("Managed mode needs single-threaded Linux startup for the network filter")
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_init.argtypes = (ctypes.c_uint32,)
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = (ctypes.c_char_p,)
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = (ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint)
    lib.seccomp_rule_add.restype = ctypes.c_int
    lib.seccomp_load.argtypes = (ctypes.c_void_p,)
    lib.seccomp_load.restype = ctypes.c_int
    lib.seccomp_release.argtypes = (ctypes.c_void_p,)
    lib.seccomp_release.restype = None

    seccomp_allow = 0x7fff0000
    seccomp_eperm = 0x00050000 | errno.EPERM
    context = lib.seccomp_init(seccomp_allow)
    if not context:
        raise RuntimeError("Could not initialize the network filter")
    try:
        # Accepted HTTP connections use the existing listener. This filter is
        # inherited by all request threads and subprocesses.
        for name in (b"socket", b"socketpair", b"connect", b"io_uring_setup"):
            syscall = lib.seccomp_syscall_resolve_name(name)
            if syscall < 0 or lib.seccomp_rule_add(context, seccomp_eperm, syscall, 0) != 0:
                raise RuntimeError(f"Could not block {name.decode()} in the network filter")
        if lib.seccomp_load(context) != 0:
            raise RuntimeError("Could not activate the managed network filter")
    finally:
        lib.seccomp_release(context)
