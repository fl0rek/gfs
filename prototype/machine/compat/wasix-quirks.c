/* PROTOTYPE. Runtime quirks of the Wasmer JS SDK (0.19.1) seen while porting
   GNU tools, papered over at link time with wasm-ld --wrap. Linked into every
   executable by wasm32-wasi-clang (see wasix.nix). Observed with a small
   probe run through `bash -c 'printf x | probe'`:

   - fstat() on a pipe end returns st_mode == 0 (no file type at all).
   - lseek() on a pipe fails with EACCES instead of ESPIPE.

   GNU grep (src/grep.c reset()) treats any lseek error other than ESPIPE on
   stdin as fatal ("Permission denied"), so `printf .. | grep ..` died. Other
   gnulib-based tools make the same assumption. */
#include <errno.h>
#include <sys/stat.h>
#include <unistd.h>

extern off_t __real_lseek(int fd, off_t off, int whence);
extern int __real_fstat(int fd, struct stat *st);

int __wrap_fstat(int fd, struct stat *st) {
  int r = __real_fstat(fd, st);
  if (r == 0 && (st->st_mode & S_IFMT) == 0)
    st->st_mode |= S_IFIFO;     /* the runtime only does this for pipes */
  return r;
}

off_t __wrap_lseek(int fd, off_t off, int whence) {
  off_t r = __real_lseek(fd, off, whence);
  if (r < 0 && errno == EACCES) {
    struct stat st;
    if (__real_fstat(fd, &st) == 0 && !S_ISREG(st.st_mode))
      errno = ESPIPE;
  }
  return r;
}
