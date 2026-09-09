#include "../async-work.h"
#include <assert.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdlib.h>
#include <time.h>

typedef struct {
  uv_work_t request;
  napi_env env;
  napi_deferred deferred;
  pthread_t owner;
  bool off_thread;
  pthread_mutex_t mutex;
  pthread_cond_t started;
  int cancel_status;
} probe;

static void work(uv_work_t *request) {
  probe *p = request->data;
  pthread_mutex_lock(&p->mutex);
  p->off_thread = !pthread_equal(p->owner, pthread_self());
  pthread_cond_signal(&p->started);
  pthread_mutex_unlock(&p->mutex);
  struct timespec delay = { .tv_sec = 0, .tv_nsec = 150000000 };
  nanosleep(&delay, NULL);
}

static void after(uv_work_t *request, int status) {
  probe *p = request->data;
  assert(pthread_equal(p->owner, pthread_self()));
  napi_value result, value;
  assert(napi_create_object(p->env, &result) == napi_ok);
  assert(napi_get_boolean(p->env, p->off_thread, &value) == napi_ok);
  assert(napi_set_named_property(p->env, result, "offThread", value) == napi_ok);
  assert(napi_create_int32(p->env, status, &value) == napi_ok);
  assert(napi_set_named_property(p->env, result, "status", value) == napi_ok);
  assert(napi_create_int32(p->env, p->cancel_status, &value) == napi_ok);
  assert(napi_set_named_property(p->env, result, "cancelStatus", value) == napi_ok);
  assert(napi_resolve_deferred(p->env, p->deferred, result) == napi_ok);
  pthread_cond_destroy(&p->started);
  pthread_mutex_destroy(&p->mutex);
  free(p);
}

static napi_value run(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2], promise;
  bool cancel = false, wait_for_start = false;
  assert(napi_get_cb_info(env, info, &argc, args, NULL, NULL) == napi_ok);
  if (argc) assert(napi_get_value_bool(env, args[0], &cancel) == napi_ok);
  if (argc > 1) assert(napi_get_value_bool(env, args[1], &wait_for_start) == napi_ok);
  probe *p = calloc(1, sizeof(*p));
  assert(p);
  assert(pthread_mutex_init(&p->mutex, NULL) == 0);
  assert(pthread_cond_init(&p->started, NULL) == 0);
  p->env = env;
  p->owner = pthread_self();
  p->request.data = p;
  p->cancel_status = UV_EBUSY;
  assert(napi_create_promise(env, &p->deferred, &promise) == napi_ok);
  uv_loop_t *loop;
  assert(napi_get_uv_event_loop(env, &loop) == napi_ok);
  assert(relayjs_queue_work(loop, &p->request, work, after) == 0);
  if (wait_for_start) {
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += 2;
    pthread_mutex_lock(&p->mutex);
    while (!p->off_thread) assert(pthread_cond_timedwait(&p->started, &p->mutex, &deadline) == 0);
    pthread_mutex_unlock(&p->mutex);
  }
  if (cancel) p->cancel_status = relayjs_cancel((uv_req_t *) &p->request);
  return promise;
}

static napi_value init(napi_env env, napi_value exports) {
  relayjs_async_init(env);
  napi_value fn;
  assert(napi_create_function(env, "run", NAPI_AUTO_LENGTH, run, NULL, &fn) == napi_ok);
  assert(napi_set_named_property(env, exports, "run", fn) == napi_ok);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
