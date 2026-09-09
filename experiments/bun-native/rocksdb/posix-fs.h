#ifndef RELAYJS_ROCKSDB_POSIX_FS_H
#define RELAYJS_ROCKSDB_POSIX_FS_H
#include <uv.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

// Only the synchronous, single-buffer calls used by pinned librocksdb are
// supported. These execute inside its background work callbacks.
static inline int relayjs_fs_result(uv_fs_t *req, int result) {
  req->result = result;
  return result;
}
static inline int relayjs_fs_mkdir(uv_loop_t *loop, uv_fs_t *req, const char *path, int mode, uv_fs_cb cb) {
  if (loop || cb) return relayjs_fs_result(req, UV_ENOSYS);
  int result;
  do { result = mkdir(path, (mode_t) mode); } while (result == -1 && errno == EINTR);
  return relayjs_fs_result(req, result == -1 ? -errno : result);
}
static inline int relayjs_fs_open(uv_loop_t *loop, uv_fs_t *req, const char *path, int flags, int mode, uv_fs_cb cb) {
  if (loop || cb) return relayjs_fs_result(req, UV_ENOSYS);
  int result;
  do { result = open(path, flags | O_CLOEXEC, (mode_t) mode); } while (result == -1 && errno == EINTR);
  return relayjs_fs_result(req, result == -1 ? -errno : result);
}
static inline int relayjs_fs_close(uv_loop_t *loop, uv_fs_t *req, uv_file fd, uv_fs_cb cb) {
  if (loop || cb) return relayjs_fs_result(req, UV_ENOSYS);
  // Linux closes the descriptor even on EINTR; retrying can close a reused fd.
  int result = close(fd);
  if (result == -1 && (errno == EINTR || errno == EINPROGRESS)) result = 0;
  return relayjs_fs_result(req, result == -1 ? -errno : result);
}
static inline int relayjs_fs_read(uv_loop_t *loop, uv_fs_t *req, uv_file fd, const uv_buf_t buffers[], unsigned int count, int64_t offset, uv_fs_cb cb) {
  if (loop || cb || count != 1 || offset < 0) return relayjs_fs_result(req, UV_ENOSYS);
  ssize_t result;
  do { result = pread(fd, buffers[0].base, buffers[0].len, offset); } while (result == -1 && errno == EINTR);
  return relayjs_fs_result(req, result == -1 ? -errno : (int) result);
}
static inline int relayjs_fs_write(uv_loop_t *loop, uv_fs_t *req, uv_file fd, const uv_buf_t buffers[], unsigned int count, int64_t offset, uv_fs_cb cb) {
  if (loop || cb || count != 1 || offset < 0) return relayjs_fs_result(req, UV_ENOSYS);
  size_t written = 0;
  while (written < buffers[0].len) {
    ssize_t result = pwrite(fd, buffers[0].base + written, buffers[0].len - written, offset + written);
    if (result == -1 && errno == EINTR) continue;
    if (result <= 0) return relayjs_fs_result(req, written ? (int) written : (result == -1 ? -errno : UV_EIO));
    written += (size_t) result;
  }
  return relayjs_fs_result(req, (int) written);
}
static inline void relayjs_fs_cleanup(uv_fs_t *req) { (void) req; }
#define uv_fs_mkdir relayjs_fs_mkdir
#define uv_fs_open relayjs_fs_open
#define uv_fs_close relayjs_fs_close
#define uv_fs_read relayjs_fs_read
#define uv_fs_write relayjs_fs_write
#define uv_fs_req_cleanup relayjs_fs_cleanup
#endif
