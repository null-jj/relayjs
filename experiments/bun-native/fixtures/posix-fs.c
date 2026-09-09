#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

static int injected_close_error;
static int test_close(int fd) {
  if (injected_close_error) { errno = injected_close_error; return -1; }
  return close(fd);
}
#define close test_close
#include "../rocksdb/posix-fs.h"
#undef close

int main(int argc, char **argv) {
  assert(argc == 2);
  uv_fs_t req;
  req.data = &req;
  assert(uv_fs_open(NULL, &req, "/relayjs-definitely-missing-directory/file", O_RDONLY, 0, NULL) == UV_ENOENT);
  int fd = uv_fs_open(NULL, &req, argv[1], O_CREAT | O_EXCL | O_RDWR, 0600, NULL);
  assert(fd >= 0);
  assert(fcntl(fd, F_GETFD) & FD_CLOEXEC);
  char payload[] = "binary\0payload";
  uv_buf_t buffer = { .base = payload, .len = sizeof(payload) };
  assert(uv_fs_write(NULL, &req, fd, &buffer, 1, 3, NULL) == sizeof(payload));
  assert(lseek(fd, 0, SEEK_CUR) == 0);
  char restored[sizeof(payload)] = {0};
  buffer.base = restored;
  assert(uv_fs_read(NULL, &req, fd, &buffer, 1, 3, NULL) == sizeof(payload));
  assert(memcmp(payload, restored, sizeof(payload)) == 0);
  assert(lseek(fd, 0, SEEK_CUR) == 0);
  assert(uv_fs_close(NULL, &req, fd, NULL) == 0);
  assert(uv_fs_close(NULL, &req, -1, NULL) == UV_EBADF);
  assert(req.result == UV_EBADF && req.data == &req);
  injected_close_error = EINTR;
  assert(uv_fs_close(NULL, &req, -1, NULL) == 0);
  injected_close_error = EINPROGRESS;
  assert(uv_fs_close(NULL, &req, -1, NULL) == 0);
  uv_fs_req_cleanup(&req);
  return 0;
}
