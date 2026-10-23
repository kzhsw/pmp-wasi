// pmp-wasi adaptation. SPDX-License-Identifier: MIT
#pragma once

namespace pmp {
[[noreturn]] inline void fail() { __builtin_trap(); }
}
