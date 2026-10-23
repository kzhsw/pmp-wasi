// SPDX-License-Identifier: MIT
#include <cstdlib>
#include <cstdint>
#include <__verbose_abort>

// Fatal paths preserve failure behavior without formatting or host interaction.
extern "C" void abort() { __builtin_trap(); }
extern "C" void __abort_message(const char*, ...) { __builtin_trap(); }
_LIBCPP_BEGIN_NAMESPACE_STD
void __libcpp_verbose_abort(const char*, ...) noexcept { __builtin_trap(); }
_LIBCPP_END_NAMESPACE_STD

// SDK LTO eagerly resolves these libcalls before eliminating dead library code.
// The build MUST reject either symbol surviving in the linked live graph.
// A fixed stack canary is never shipped.
extern "C" {
uintptr_t __stack_chk_guard = 0;
void __stack_chk_fail() { __builtin_trap(); }
}
