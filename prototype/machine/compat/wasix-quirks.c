/* PROTOTYPE. Runtime quirks of the Wasmer JS SDK (0.19.1) seen while porting
   GNU tools, papered over at link time with wasm-ld --wrap. Linked into every
   executable by wasm32-wasi-clang (see wasix.nix). Observed with a small
   probe run through `bash -c 'printf x | probe'`:

   - fstat() on a pipe end returns st_mode == 0 (no file type at all).
   - lseek() on a pipe fails with EACCES instead of ESPIPE.

   - program_invocation_name / __progname stay NULL: wasi-libc's startup
     never sets them, so gnulib's getprogname() prints "(null)".

   GNU grep (src/grep.c reset()) treats any lseek error other than ESPIPE on
   stdin as fatal ("Permission denied"), so `printf .. | grep ..` died. Other
   gnulib-based tools make the same assumption. */
#define _GNU_SOURCE 1
#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* clang renames the user's main to __main_argc_argv on wasm32-wasi; libc's
   __main_void fetches argv and calls it. Wrapping that call is the one place
   argv is in hand before main runs. */
extern int __real___main_argc_argv(int argc, char **argv);
extern char *__progname, *__progname_full;
int __wrap___main_argc_argv(int argc, char **argv) {
  if (argc > 0 && argv[0]) {
    program_invocation_name = __progname_full = argv[0];
    char *slash = strrchr(argv[0], '/');
    program_invocation_short_name = __progname = slash ? slash + 1 : argv[0];
  }
  return __real___main_argc_argv(argc, argv);
}

extern off_t __real_lseek(int fd, off_t off, int whence);
extern off_t __real___wasilibc_tell(int fd);
extern int __real_fstat(int fd, struct stat *st);

/* wasi-libc's <unistd.h> rewrites lseek(fd, 0, SEEK_CUR) into
   __wasilibc_tell(fd) with a macro, so that one needs the same treatment. */
static off_t fix_seek_errno(int fd, off_t r) {
  if (r < 0 && errno == EACCES) {
    struct stat st;
    if (__real_fstat(fd, &st) == 0 && !S_ISREG(st.st_mode))
      errno = ESPIPE;
  }
  return r;
}

off_t __wrap___wasilibc_tell(int fd) {
  return fix_seek_errno(fd, __real___wasilibc_tell(fd));
}

int __wrap_fstat(int fd, struct stat *st) {
  int r = __real_fstat(fd, st);
  if (r == 0 && (st->st_mode & S_IFMT) == 0)
    st->st_mode |= S_IFIFO;     /* the runtime only does this for pipes */
  return r;
}

off_t __wrap_lseek(int fd, off_t off, int whence) {
  return fix_seek_errno(fd, __real_lseek(fd, off, whence));
}
