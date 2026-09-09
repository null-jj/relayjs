#ifndef RELAYJS_ASYNC_WORK_H
#define RELAYJS_ASYNC_WORK_H
#include <node_api.h>
#include <uv.h>
#ifdef __cplusplus
extern "C" {
#endif
// Hidden symbols keep each rebuilt addon's environment and requests independent.
__attribute__((visibility("hidden"))) void relayjs_async_init(napi_env env);
__attribute__((visibility("hidden"))) int relayjs_queue_work(uv_loop_t *, uv_work_t *, uv_work_cb, uv_after_work_cb);
__attribute__((visibility("hidden"))) int relayjs_cancel(uv_req_t *);
#ifdef __cplusplus
}
#endif
#define uv_queue_work relayjs_queue_work
#define uv_cancel relayjs_cancel
#endif
