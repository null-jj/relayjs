#include "async-work.h"
#include <stdlib.h>

typedef struct relayjs_work {
  napi_async_work handle;
  uv_work_t *request;
  uv_work_cb execute;
  uv_after_work_cb complete;
  struct relayjs_work *next;
} relayjs_work;

// Node-API entry points and completion callbacks run on the environment thread.
// Worker callbacks use only their payload, never this thread-local state.
static _Thread_local napi_env environment;
static _Thread_local relayjs_work *pending;

void relayjs_async_init(napi_env env) {
  environment = env;
}

static void execute(napi_env env, void *data) {
  (void) env;
  relayjs_work *work = data;
  work->execute(work->request);
}

static void complete(napi_env env, napi_status status, void *data) {
  relayjs_work *work = data;
  relayjs_work **cursor = &pending;
  while (*cursor && *cursor != work) cursor = &(*cursor)->next;
  if (*cursor) *cursor = work->next;
  napi_delete_async_work(env, work->handle);
  // The upstream completion may free the request. Never access it afterward.
  if (work->complete) work->complete(work->request, status == napi_ok ? 0 : UV_ECANCELED);
  free(work);
}

int relayjs_queue_work(uv_loop_t *loop, uv_work_t *request, uv_work_cb work_cb, uv_after_work_cb after_cb) {
  if (!environment || !request || !work_cb) return UV_EINVAL;
  for (relayjs_work *item = pending; item; item = item->next) {
    if (item->request == request) return UV_EBUSY;
  }
  relayjs_work *work = calloc(1, sizeof(*work));
  if (!work) return UV_ENOMEM;
  work->request = request;
  work->execute = work_cb;
  work->complete = after_cb;
  request->loop = loop;
  request->type = UV_WORK;
  napi_value name;
  napi_status status = napi_create_string_utf8(environment, "relayjs:native-work", NAPI_AUTO_LENGTH, &name);
  if (status == napi_ok) status = napi_create_async_work(environment, NULL, name, execute, complete, work, &work->handle);
  if (status == napi_ok) status = napi_queue_async_work(environment, work->handle);
  if (status != napi_ok) {
    if (work->handle) napi_delete_async_work(environment, work->handle);
    free(work);
    return UV_EIO;
  }
  work->next = pending;
  pending = work;
  return 0;
}

int relayjs_cancel(uv_req_t *request) {
  if (!environment || !request) return UV_EINVAL;
  for (relayjs_work *work = pending; work; work = work->next) {
    if ((uv_req_t *) work->request != request) continue;
    return napi_cancel_async_work(environment, work->handle) == napi_ok ? 0 : UV_EBUSY;
  }
  return UV_EINVAL;
}
