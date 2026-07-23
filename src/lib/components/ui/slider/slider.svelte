<script lang="ts">
	import { Slider as SliderPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		bufferedRanges = [],
		orientation = 'horizontal',
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SliderPrimitive.RootProps> & {
		bufferedRanges?: Array<{ start: number; end: number }>;
	} = $props();

	let normalizedBufferedRanges = $derived(
		bufferedRanges
			.map(({ start, end }) => ({
				start: Math.max(0, Math.min(100, Number(start))),
				end: Math.max(0, Math.min(100, Number(end)))
			}))
			.filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
	);
</script>

<SliderPrimitive.Root
	bind:ref
	bind:value={value as never}
	data-slot="slider"
	{orientation}
	class={cn(
		'relative flex touch-none items-center select-none data-disabled:opacity-50 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
		className
	)}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			class="relative grow overflow-hidden rounded-full bg-(--text)/12 data-[orientation=horizontal]:h-2.5 data-[orientation=vertical]:w-2.5"
		>
			{#if orientation === 'horizontal'}
				{#each normalizedBufferedRanges as range}
					<span
						data-slot="slider-buffer"
						class="pointer-events-none absolute inset-y-0 rounded-full bg-(--text)/24 transition-[left,width] duration-500 ease-out"
						style:left={`${range.start}%`}
						style:width={`${range.end - range.start}%`}
					></span>
				{/each}
			{/if}
			<SliderPrimitive.Range
				data-slot="slider-range"
				data-orientation={orientation}
				class="absolute rounded-full bg-(--text) data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
			/>
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				index={thumb.index}
				data-slot="slider-thumb"
				class="block size-5 shrink-0 rounded-full border border-(--text)/8 bg-(--bg-elevated) shadow-sm outline-none transition-[box-shadow,transform] active:scale-110 focus-visible:ring-2 focus-visible:ring-(--text)/24 disabled:pointer-events-none disabled:opacity-50"
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>
