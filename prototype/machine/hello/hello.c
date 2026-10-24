/* PROTOTYPE. Smallest program that exercises the WASIX toolchain:
   stdio, argv, environment, a thread (WASIX libc is built -pthread), and a
   non-zero exit code when asked. */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void *worker(void *arg) {
  const char *s = arg;
  printf("thread says: %s\n", s);
  return NULL;
}

int main(int argc, char **argv) {
  printf("hello from wasix (pid %d)\n", (int)getpid());
  for (int i = 0; i < argc; i++)
    printf("argv[%d]=%s\n", i, argv[i]);
  const char *h = getenv("HOME");
  printf("HOME=%s\n", h ? h : "(unset)");

  pthread_t t;
  if (pthread_create(&t, NULL, worker, "hi") == 0)
    pthread_join(t, NULL);
  else
    printf("pthread_create failed\n");

  if (argc > 1 && strcmp(argv[1], "fail") == 0)
    return 3;
  return 0;
}
