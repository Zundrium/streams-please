<script lang="ts">
  import { cn } from '$lib/utils';

  const REVEAL_DELAY_MS = 110;
  const REVEAL_DURATION_MS = 920;

  let {
    value,
    max,
    remaining,
    valueLabel,
    remainingLabel = 'left',
    color = 'var(--chart-4)',
    loading = false,
    ariaLabel = 'Progress',
    loadingText = 'Loading progress',
    class: className
  }: {
    value: number;
    max: number;
    remaining?: number;
    valueLabel: string;
    remainingLabel?: string;
    color?: string;
    loading?: boolean;
    ariaLabel?: string;
    loadingText?: string;
    class?: string;
  } = $props();

  let displayedValue = $state(0);
  let displayedRemaining = $state(0);
  let displayedProgress = $state(0);
  let copyVisible = $state(false);

  let normalizedMax = $derived(Math.max(0, Math.round(max)));
  let normalizedValue = $derived(
    Math.max(0, Math.min(Math.round(value), normalizedMax))
  );
  let normalizedRemaining = $derived(
    Math.max(
      0,
      Math.round(remaining ?? Math.max(0, normalizedMax - normalizedValue))
    )
  );
  let targetProgress = $derived(
    normalizedMax ? (normalizedValue / normalizedMax) * 100 : 0
  );
  let ready = $derived(!loading && normalizedMax > 0);

  $effect(() => {
    const reveal = ready;
    const targetValue = normalizedValue;
    const targetRemaining = normalizedRemaining;
    const targetPercentage = targetProgress;

    displayedValue = 0;
    displayedRemaining = 0;
    displayedProgress = 0;
    copyVisible = false;

    if (!reveal || typeof window === 'undefined') return;

    let frame = window.requestAnimationFrame((firstFrameTime) => {
      copyVisible = true;

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        displayedValue = targetValue;
        displayedRemaining = targetRemaining;
        displayedProgress = targetPercentage;
        return;
      }

      const animationStart = firstFrameTime + REVEAL_DELAY_MS;
      const animate = (time: number) => {
        const elapsed = Math.max(0, time - animationStart);
        const fraction = Math.min(1, elapsed / REVEAL_DURATION_MS);
        const eased = 1 - Math.pow(1 - fraction, 4);

        displayedValue = Math.round(targetValue * eased);
        displayedRemaining = Math.round(targetRemaining * eased);
        displayedProgress = targetPercentage * eased;

        if (fraction < 1) {
          frame = window.requestAnimationFrame(animate);
        } else {
          displayedValue = targetValue;
          displayedRemaining = targetRemaining;
          displayedProgress = targetPercentage;
        }
      };

      frame = window.requestAnimationFrame(animate);
    });

    return () => window.cancelAnimationFrame(frame);
  });
</script>

<div
  class={cn('min-w-0 w-full', className)}
  data-animated-progress
  data-progress-state={copyVisible ? 'revealing' : 'loading'}
  aria-busy={!ready}
  style={`--animated-progress-color: ${color}`}
>
  <div class="mb-2 hidden items-center justify-between text-xs text-(--text)/42 sm:flex" aria-hidden="true">
    <span class="progress-label">{displayedValue} {valueLabel}</span>
    <span class="progress-label progress-label-right">{displayedRemaining} {remainingLabel}</span>
  </div>
  <div
    class="progress-track h-1.5 overflow-hidden rounded-full"
    role="progressbar"
    aria-label={ariaLabel}
    aria-valuemin="0"
    aria-valuemax={Math.max(normalizedMax, 1)}
    aria-valuenow={ready ? normalizedValue : 0}
    aria-valuetext={ready ? `${normalizedValue} of ${normalizedMax} ${valueLabel}` : loadingText}
  >
    <div class="progress-fill h-full rounded-full" style={`width: ${displayedProgress}%`}></div>
  </div>
</div>

<style>
  .progress-label {
    opacity: 0;
    filter: blur(3px);
    transform: translateY(0.3rem);
    transition:
      opacity 420ms ease,
      filter 520ms ease,
      transform 520ms var(--ease-spring);
  }

  .progress-label-right {
    transition-delay: 70ms;
  }

  [data-progress-state='revealing'] .progress-label {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0);
  }

  .progress-track {
    position: relative;
    isolation: isolate;
    background: color-mix(in srgb, var(--text) 8%, transparent);
    box-shadow:
      inset 0 1px 1px color-mix(in srgb, var(--text) 5%, transparent),
      0 1px 0 color-mix(in srgb, var(--bg-elevated) 70%, transparent);
  }

  .progress-fill {
    position: relative;
    overflow: hidden;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--animated-progress-color) 76%, var(--text)),
      var(--animated-progress-color)
    );
    box-shadow: 0 0 16px color-mix(in srgb, var(--animated-progress-color) 44%, transparent);
    will-change: width;
  }

  .progress-fill::after {
    position: absolute;
    inset-block: 0;
    left: -45%;
    width: 38%;
    background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.72), transparent);
    content: '';
    opacity: 0;
    transform: skewX(-18deg);
  }

  [data-progress-state='revealing'] .progress-fill::after {
    animation: progress-sheen 820ms ease-out 180ms both;
  }

  @keyframes progress-sheen {
    0% {
      left: -45%;
      opacity: 0;
    }
    22% {
      opacity: 0.75;
    }
    100% {
      left: 112%;
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-label {
      transition-duration: 1ms;
      transition-delay: 0ms;
    }

    [data-progress-state='revealing'] .progress-fill::after {
      animation: none;
    }
  }
</style>
