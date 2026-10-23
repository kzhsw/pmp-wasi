// SPDX-License-Identifier: MIT
// Development artifact only. Link with --wrap for every allocator entry point
// used by the SDK. Internal dlmalloc calls stay unwrapped, avoiding double counts.
// Counts usable allocation bytes, excluding allocator metadata and free chunks.
// Allocation/release events include successful realloc replacements (even in
// place); they are not counts of underlying dlmalloc internal calls.
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <malloc.h>

namespace {
uint32_t live_bytes, peak_bytes, live_blocks, peak_blocks;
uint32_t allocations, frees, reallocations;
void check(bool value) { if (!value) __builtin_trap(); }
void add(void* pointer)
{
    if (!pointer) return;
    const auto bytes = malloc_usable_size(pointer);
    check(bytes <= UINT32_MAX - live_bytes && live_blocks != UINT32_MAX);
    live_bytes += bytes;
    ++live_blocks;
    ++allocations;
    if (live_bytes > peak_bytes) peak_bytes = live_bytes;
    if (live_blocks > peak_blocks) peak_blocks = live_blocks;
}
void subtract(size_t bytes)
{
    check(live_blocks && bytes <= live_bytes);
    live_bytes -= bytes;
    --live_blocks;
    ++frees;
}
} // namespace

extern "C" {
void* __real_malloc(size_t);
void* __real_calloc(size_t, size_t);
void* __real_realloc(void*, size_t);
void __real_free(void*);
void* __real_aligned_alloc(size_t, size_t);
int __real_posix_memalign(void**, size_t, size_t);
void* __libc_malloc(size_t);
void* __libc_calloc(size_t, size_t);
void __libc_free(void*);

void* __wrap_malloc(size_t bytes)
{
    auto* pointer = __real_malloc(bytes);
    add(pointer);
    return pointer;
}
void* __wrap_calloc(size_t count, size_t bytes)
{
    auto* pointer = __real_calloc(count, bytes);
    add(pointer);
    return pointer;
}
void __wrap_free(void* pointer)
{
    if (pointer) subtract(malloc_usable_size(pointer));
    __real_free(pointer);
}
void* __wrap_realloc(void* pointer, size_t bytes)
{
    // Read before realloc can release/move the old chunk. On allocation failure
    // the old allocation remains live. A zero-size call can return a minimum
    // allocation or null; both release the previous allocation identity.
    const auto old_bytes = pointer ? malloc_usable_size(pointer) : 0;
    auto* result = __real_realloc(pointer, bytes);
    ++reallocations;
    if (result || !bytes) {
        if (pointer) subtract(old_bytes);
        add(result);
    }
    return result;
}
void* __wrap_aligned_alloc(size_t alignment, size_t bytes)
{
    auto* pointer = __real_aligned_alloc(alignment, bytes);
    add(pointer);
    return pointer;
}
int __wrap_posix_memalign(void** output, size_t alignment, size_t bytes)
{
    const auto status = __real_posix_memalign(output, alignment, bytes);
    if (!status) add(*output);
    return status;
}
void* __wrap___libc_malloc(size_t bytes) { return __wrap_malloc(bytes); }
void* __wrap___libc_calloc(size_t count, size_t bytes) { return __wrap_calloc(count, bytes); }
void __wrap___libc_free(void* pointer) { __wrap_free(pointer); }

uint32_t pmp_profile_get(uint32_t index)
{
    switch (index) {
        case 0: return live_bytes;
        case 1: return peak_bytes;
        case 2: return live_blocks;
        case 3: return peak_blocks;
        case 4: return allocations;
        case 5: return frees;
        case 6: return reallocations;
        case 7: return __builtin_wasm_memory_size(0) * 65536u;
        default: __builtin_trap();
    }
}
void pmp_profile_reset()
{
    peak_bytes = live_bytes;
    peak_blocks = live_blocks;
    allocations = frees = reallocations = 0;
}
void pmp_profile_self_test()
{
    const auto bytes = live_bytes, blocks = live_blocks;
    auto* a = std::malloc(19);
    check(a && live_blocks == blocks + 1 && live_bytes >= bytes + 19);
    a = std::realloc(a, 4096);
    check(a && live_blocks == blocks + 1 && live_bytes >= bytes + 4096);
    std::free(a);
    check(live_bytes == bytes && live_blocks == blocks);
    auto* b = std::calloc(7, 13);
    check(b && live_blocks == blocks + 1);
    for (size_t i = 0; i < 91; ++i) check(static_cast<unsigned char*>(b)[i] == 0);
    std::free(b);
    auto* c = std::aligned_alloc(64, 128);
    check(c && reinterpret_cast<uintptr_t>(c) % 64 == 0 && live_blocks == blocks + 1);
    std::free(c);
    void* d = nullptr;
    check(posix_memalign(&d, 64, 91) == 0 && d && live_blocks == blocks + 1);
    std::free(d);
    auto* e = __libc_malloc(31);
    check(e && live_blocks == blocks + 1);
    __libc_free(e);
    auto* f = __libc_calloc(3, 17);
    check(f && live_blocks == blocks + 1);
    __libc_free(f);
    auto* g = std::realloc(nullptr, 32);
    check(g && live_blocks == blocks + 1);
    g = std::realloc(g, 0);
    std::free(g);
    // Check the SDK's fundamental 16-byte malloc alignment on differently sized
    // simultaneously live chunks, including reallocation. Eigen can rely on it.
    void* buffers[16];
    for (size_t i = 0; i < 16; ++i) {
        buffers[i] = std::malloc(i * 17 + 1);
        check(buffers[i] && reinterpret_cast<uintptr_t>(buffers[i]) % 16 == 0);
        buffers[i] = std::realloc(buffers[i], i * 33 + 257);
        check(buffers[i] && reinterpret_cast<uintptr_t>(buffers[i]) % 16 == 0);
    }
    for (auto* buffer : buffers) std::free(buffer);
    // Overflow must fail without disturbing live allocation accounting.
    check(std::calloc(SIZE_MAX, 2) == nullptr);
    check(live_bytes == bytes && live_blocks == blocks);
}
} // extern "C"
