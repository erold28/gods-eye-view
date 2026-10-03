import * as Cesium from 'cesium';
import { flyToLandmark } from '../locations.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { LIVE_CONFIG } from './config.js';
import { liveFramingPlan, screenOffsetRadians } from './framing.js';

const RENDER_OWNER = 'live-idle-orbit';
/** Seconds the view takes to tilt up after arriving. */
const SETTLE_SECONDS = 0.8;

/**
 * The live mode's camera: flights to requests and the waiting-mode spin.
 *
 * Flights use the app's own `flyToLandmark`, which reads the ground height
 * (also under Google 3D Tiles, through the ground-floor service) and lifts the
 * eye if it would be buried. On arrival the view tilts up so the place sits
 * low on screen (`camera.placeScreenY`), below the banner, not under it.
 *
 * The waiting spin circles the last place and keeps it at that same height on
 * screen. Without a place yet, it circles the point at the centre of the view.
 */
export function createLiveCamera({
  viewer,
  ground = null,
  config = LIVE_CONFIG,
}) {
  const settings = config.camera;
  let target = null;
  let lastPlan = null;
  let generation = 0;
  let removeOrbit = null;

  const offset = () =>
    screenOffsetRadians(
      viewer.camera.frustum?.fovy ?? Cesium.Math.toRadians(60),
      settings.placeScreenY,
    );

  const stopIdle = () => {
    if (!removeOrbit) return;
    removeOrbit();
    removeOrbit = null;
    releaseContinuousRender(RENDER_OWNER);
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  };

  /** Tilt up in place so the target drops to `placeScreenY`. */
  const settle = (flight) => {
    if (flight !== generation || viewer.isDestroyed?.()) return;
    const camera = viewer.camera;
    camera.flyTo({
      destination: Cesium.Cartesian3.clone(camera.positionWC),
      orientation: {
        heading: camera.heading,
        pitch: Math.min(-0.05, camera.pitch + offset()),
        roll: 0,
      },
      duration: SETTLE_SECONDS,
    });
  };

  return {
    /** Fly to an accepted place `{ lat, lng, types, viewport }`. */
    flyTo(place) {
      stopIdle();
      const flight = ++generation;
      viewer.trackedEntity = undefined;
      const plan = liveFramingPlan(place, settings);
      lastPlan = plan;
      const result = flyToLandmark(viewer, place.lat, place.lng, {
        range: plan.rangeM,
        pitch: plan.pitchDeg,
        heading: 0,
        buildingHeight: 0,
        duration: settings.flightSeconds,
        ground,
        onComplete: () => settle(flight),
      });
      target = result?.targetPosition || null;
      return plan;
    },

    /** Circle the last place (or the view's centre) slowly, kept low on screen. */
    startIdle() {
      stopIdle();
      generation++;
      const camera = viewer.camera;
      let center = target;
      let range = center
        ? Cesium.Cartesian3.distance(camera.positionWC, center)
        : null;
      if (!center) {
        const canvas = viewer.scene.canvas;
        const ray = camera.getPickRay(
          new Cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
        );
        center =
          (ray &&
            viewer.scene.globe?.show &&
            viewer.scene.globe.pick(ray, viewer.scene)) ||
          null;
        if (!center) return false;
        range = Cesium.Cartesian3.distance(camera.positionWC, center);
      }
      const pitch = Cesium.Math.toRadians(lastPlan?.pitchDeg ?? -30);
      const lift = target ? offset() : 0;
      const speed = Cesium.Math.toRadians(settings.idleOrbitDegreesPerSecond);
      let heading = camera.heading;
      let last = Date.now();
      holdContinuousRender(RENDER_OWNER);
      removeOrbit = viewer.scene.preRender.addEventListener(() => {
        const now = Date.now();
        heading += speed * ((now - last) / 1000);
        last = now;
        camera.lookAt(
          center,
          new Cesium.HeadingPitchRange(heading, pitch, range),
        );
        if (lift) camera.lookUp(lift);
      });
      return true;
    },

    stopIdle,

    destroy() {
      generation++;
      stopIdle();
    },
  };
}
