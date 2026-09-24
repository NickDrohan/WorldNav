import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  BloomEffect,
  ChromaticAberrationEffect,
  VignetteEffect,
  NoiseEffect,
  ScanlineEffect,
  SMAAEffect,
  SMAAPreset,
  BlendFunction,
  KernelSize,
} from "postprocessing";

export function createPostFX(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): EffectComposer {
  const composer = new EffectComposer(renderer, {
    frameBufferType: undefined,
  });

  composer.addPass(new RenderPass(scene, camera));

  const bloom = new BloomEffect({
    intensity: 1.8,
    luminanceThreshold: 0.12,
    luminanceSmoothing: 0.6,
    kernelSize: KernelSize.MEDIUM,
  });

  const chromaticAberration = new ChromaticAberrationEffect({
    radialModulation: true,
    modulationOffset: 0.25,
  });

  const vignette = new VignetteEffect({
    darkness: 0.6,
    offset: 0.3,
  });

  const noise = new NoiseEffect({
    blendFunction: BlendFunction.OVERLAY,
  });
  noise.blendMode.opacity.value = 0.04;

  const scanline = new ScanlineEffect({
    blendFunction: BlendFunction.OVERLAY,
    density: 1.8,
  });
  scanline.blendMode.opacity.value = 0.08;

  const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });

  composer.addPass(
    new EffectPass(camera, bloom, chromaticAberration, vignette, noise, scanline),
  );
  composer.addPass(new EffectPass(camera, smaa));

  return composer;
}
