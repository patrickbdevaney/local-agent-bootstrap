## --cache-type-k

This flag sets the KV cache data type for the K attention projection, controlling memory efficiency versus precision. The allowed values are f32, f16, bf16, and various quantized formats (q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1), with f16 being the default. Lower precision types reduce memory usage at the cost of potential accuracy tradeoffs.

## flash attention

The `-fa` flag enables Flash Attention, an optimized attention implementation that significantly improves inference speed and reduces memory bandwidth requirements on supported hardware. When set to 'on', Flash Attention is always used; 'off' disables it entirely; and 'auto' (the default) enables it when the hardware backend supports it.

## Sources

https://github.com/ggml-org/llama.cpp/blob/master/tools/cli/README.md
