#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
/* Cage 0.3.1 advertises xdg-shell v5, Aquamarine requires v6 unconditionally.
 * wlroots 0.20 supports v6. This shim modifies only our private Cage parent. */
void *wlr_xdg_shell_create(void *display, uint32_t version) {
    void *(*real_create)(void *, uint32_t) = dlsym(RTLD_NEXT, "wlr_xdg_shell_create");
    return real_create(display, version < 6 ? 6 : version);
}
