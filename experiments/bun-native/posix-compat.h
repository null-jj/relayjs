#ifndef RELAYJS_FS_NATIVE_POSIX_COMPAT_H
#define RELAYJS_FS_NATIVE_POSIX_COMPAT_H

#include <uv.h>

#ifndef _WIN32
// Match libuv's POSIX value conversions without calling Bun's missing exports.
// OS lock acquisition, conflict detection, and release stay in upstream code.
static inline uv_os_fd_t relayjs_os_handle(int fd) {
  return fd;
}

static inline uv_buf_t relayjs_buf_init(char *base, unsigned int length) {
  uv_buf_t buffer;
  buffer.base = base;
  buffer.len = length;
  return buffer;
}

static inline int relayjs_translate_sys_error(int error) {
  return error <= 0 ? error : -error;
}

// Reuse the installed libuv headers' error names/messages, including EAGAIN
// (lock contention) and EBADF. Do not turn lock failures into successes.
static inline const char *relayjs_err_name(int error) {
  switch (error) {
#define RELAYJS_ERROR_NAME(code, message) case UV_##code: return #code;
    UV_ERRNO_MAP(RELAYJS_ERROR_NAME)
#undef RELAYJS_ERROR_NAME
    default: return "UNKNOWN";
  }
}

static inline const char *relayjs_strerror(int error) {
  switch (error) {
#define RELAYJS_ERROR_MESSAGE(code, message) case UV_##code: return message;
    UV_ERRNO_MAP(RELAYJS_ERROR_MESSAGE)
#undef RELAYJS_ERROR_MESSAGE
    default: return "Unknown system error";
  }
}

#define uv_get_osfhandle relayjs_os_handle
#define uv_buf_init relayjs_buf_init
#define uv_translate_sys_error relayjs_translate_sys_error
#define uv_err_name relayjs_err_name
#define uv_strerror relayjs_strerror
#endif
#endif
