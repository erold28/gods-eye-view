import * as Cesium from 'cesium';
import { flyToLandmark } from '../locations.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { LIVE_CONFIG } from './config.js';
import {
  descentView,
  liveFramingPlan,
  screenOffsetRadians,
} from './framing.js';

const RENDER_OWNER = 'live-tour';
/** Seconds the view takes to tilt the place down below the banner. */
const LIFT_SECONDS = 1.5;
/** How fast a corrected ground height is eased in, per second. */
const GROUND_EASE_PER_SECOND = 1.5;

/**
 * The live mode's camera: a mini tour of each requested place.
 *
 *   flight   → the app's own flyToLandmark (reads the ground, never buries the
 *              eye), slow and eased, ending on the general view
 *   overview → the general view, turning almost imperceptibly
 *   wait     → the same, while Google 3D is still loading (bounded)
 *   descent  → a slow, eased descent to the close view
 *   orbit    → a very slow turn around the centre, until the next request
 *
 * Countries and states come down too, to a height that still shows their
 * cities; large areas (parks, mountain ranges) have no close view and orbit
 * high.
 * Throughout, the centre of the place sits low on screen (`placeScreenY`),
 * below the banner.
 *
 * Moving the map with the mouse, wheel or touch hands the camera to the
 * streamer at once: `onTakeover()` is called and the tour stops where it was.
 * `resume()` flies back to that phase and carries on.
 */
export function createLiveCamera({
  viewer,
  ground = null,
  config = LIVE_CONFIG,
  onTakeover = null,
}) {
  const settings = config.camera;
  const camera = viewer.camera;
  const canvas = viewer.scene.canvas;
  let tour = null;
  let removeFrame = null;
  let generation = 0;
  let userControl = false;

  const lift = () =>
    screenOffsetRadians(
      camera.frustum?.fovy ?? Cesium.Math.toRadians(60),
      settings.placeScreenY,
    );

  const stopFrames = () => {
    if (!removeFrame) return;
    removeFrame();
    removeFrame = null;
    releaseContinuousRender(RENDER_OWNER);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  };

  const now = () => performance.now();

  const anyTilesLoading = () => {
    const primitives = viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) {
      const primitive = primitives.get(i);
      if (primitive?.show && primitive.tilesLoaded === false) return true;
    }
    return false;
  };

  /** Measure the rendered ground under the centre (3D tiles or terrain). */
  const sampleGround = (current) => {
    const scene = viewer.scene;
    if (!scene.sampleHeightSupported) return;
    const carto = Cesium.Cartographic.fromDegrees(current.lng, current.lat);
    Promise.resolve(scene.sampleHeightMostDetailed([carto]))
      .then(([sampled]) => {
        if (tour === current && Number.isFinite(sampled?.height))
          current.groundTarget = sampled.height;
      })
      .catch(() => {});
  };

  const targetPosition = (current) =>
    Cesium.Cartesian3.fromDegrees(current.lng, current.lat, current.ground);

  /** The view the tour should show right now, and the turn speed. */
  const currentView = (current, t) => {
    const elapsed = (t - current.phaseStart) / 1000;
    const { overview } = current.plan;
    switch (current.phase) {
      case 'overview':
        return {
          view: overview,
          speed: settings.overviewDriftDegreesPerSecond,
        };
      case 'wait':
        return {
          view: overview,
          speed: settings.overviewDriftDegreesPerSecond,
        };
      case 'descent':
        return {
          view: descentView(current.plan, elapsed / settings.descentSeconds),
          speed:
            settings.overviewDriftDegreesPerSecond +
            (settings.orbitDegreesPerSecond -
              settings.overviewDriftDegreesPerSecond) *
              Math.min(1, elapsed / settings.descentSeconds),
        };
      default:
        return current.plan.close
          ? { view: current.plan.close, speed: settings.orbitDegreesPerSecond }
          : { view: overview, speed: settings.highOrbitDegreesPerSecond };
    }
  };

  /** Move to the next phase when the current one is over. */
  const advancePhase = (current, t) => {
    const elapsed = (t - current.phaseStart) / 1000;
    const next = (phase) => {
      current.phase = phase;
      current.phaseStart = t;
      if (phase === 'descent') sampleGround(current);
    };
    if (current.phase === 'overview' && elapsed >= settings.overviewSeconds) {
      if (!current.plan.close) next('orbit');
      else if (anyTilesLoading()) next('wait');
      else next('descent');
    } else if (current.phase === 'wait') {
      if (!anyTilesLoading() || elapsed >= settings.waitForTilesSeconds)
        next('descent');
    } else if (
      current.phase === 'descent' &&
      elapsed >= settings.descentSeconds
    ) {
      next('orbit');
    }
  };

  /** Drive the camera every frame from the end of the flight onwards. */
  const startFrames = (current) => {
    stopFrames();
    let last = now();
    holdContinuousRender(RENDER_OWNER);
    removeFrame = viewer.scene.preRender.addEventListener(() => {
      if (tour !== current || userControl) return;
      const t = now();
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      advancePhase(current, t);
      if (Number.isFinite(current.groundTarget))
        current.ground +=
          (current.groundTarget - current.ground) *
          Math.min(1, dt * GROUND_EASE_PER_SECOND);
      const { view, speed } = currentView(current, t);
      current.heading += Cesium.Math.toRadians(speed) * dt;
      current.lift = Math.min(1, current.lift + dt / LIFT_SECONDS);
      camera.lookAt(
        targetPosition(current),
        new Cesium.HeadingPitchRange(
          current.heading,
          Cesium.Math.toRadians(view.pitchDeg),
          view.rangeM,
        ),
      );
      camera.lookUp(lift() * smooth(current.lift));
    });
  };

  const smooth = (x) => x * x * (3 - 2 * x);

  /** Hand the camera to the streamer: stop flights and the tour at once. */
  const takeover = () => {
    // The startup turn just lets go; there is no tour to pause.
    if (!tour) return stopFrames();
    if (userControl) return;
    userControl = true;
    generation++;
    camera.cancelFlight();
    stopFrames();
    onTakeover?.();
  };
  const listeners = ['pointerdown', 'wheel', 'touchstart'];
  for (const type of listeners)
    canvas.addEventListener(type, takeover, { passive: true, capture: true });

  /** Begin the frame-driven phases at `phase`, from the camera's own pose. */
  const beginPhases = (current, flight, phase) => {
    if (flight !== generation || tour !== current) return;
    current.phase = phase;
    current.phaseStart = now();
    current.heading = camera.heading;
    sampleGround(current);
    startFrames(current);
  };

  return {
    /** Start the tour of an accepted place `{ lat, lng, types, viewport }`. */
    tour(place) {
      stopFrames();
      userControl = false;
      const flight = ++generation;
      viewer.trackedEntity = undefined;
      const plan = liveFramingPlan(place, settings);
      const current = {
        lat: place.lat,
        lng: place.lng,
        plan,
        phase: 'flight',
        phaseStart: now(),
        heading: 0,
        lift: 0,
        ground: 0,
        groundTarget: null,
      };
      tour = current;
      const result = flyToLandmark(viewer, place.lat, place.lng, {
        range: plan.overview.rangeM,
        pitch: plan.overview.pitchDeg,
        heading: 0,
        buildingHeight: 0,
        duration: settings.flightSeconds,
        ground,
        onComplete: () => beginPhases(current, flight, 'overview'),
      });
      // flyToLandmark already placed the centre on its best ground estimate.
      const target = result?.targetPosition;
      if (target)
        current.ground = Cesium.Cartographic.fromCartesian(target)?.height ?? 0;
      return plan;
    },

    /** Whether the streamer has taken the camera with the mouse. */
    get userControl() {
      return userControl;
    },

    get hasTour() {
      return tour !== null;
    },

    /**
     * Give the camera back to the tour: fly to the phase it was in (the
     * general view, or the close view once it had started down) and go on.
     */
    resume() {
      const current = tour;
      if (!current || !userControl) return false;
      userControl = false;
      const flight = ++generation;
      // Taken during the descent or the orbit: back to the close orbit.
      // Taken earlier: back to the general view, which starts over.
      const close =
        current.plan.close && ['descent', 'orbit'].includes(current.phase);
      const highOrbit = !current.plan.close && current.phase === 'orbit';
      const phase = close || highOrbit ? 'orbit' : 'overview';
      const view = close ? current.plan.close : current.plan.overview;
      // Work out the tour's pose with a scratch camera, then fly there.
      const scratch = new Cesium.Camera(viewer.scene);
      scratch.frustum = camera.frustum.clone();
      scratch.lookAt(
        targetPosition(current),
        new Cesium.HeadingPitchRange(
          camera.heading,
          Cesium.Math.toRadians(view.pitchDeg),
          view.rangeM,
        ),
      );
      scratch.lookUp(lift());
      scratch.lookAtTransform(Cesium.Matrix4.IDENTITY);
      camera.flyTo({
        destination: Cesium.Cartesian3.clone(scratch.positionWC),
        orientation: {
          heading: scratch.heading,
          pitch: scratch.pitch,
          roll: 0,
        },
        duration: settings.resumeSeconds,
        complete: () => {
          if (flight !== generation || tour !== current) return;
          current.lift = 1;
          beginPhases(current, flight, phase);
        },
      });
      return true;
    },

    /**
     * Slow turn at startup, before any request: around the point at the
     * centre of the view. Does nothing while a tour is running (its own
     * orbit carries on) or while the streamer holds the camera.
     */
    startIdle() {
      if (tour || userControl) return false;
      stopFrames();
      const ray = camera.getPickRay(
        new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      );
      const center =
        (ray &&
          viewer.scene.globe?.show &&
          viewer.scene.globe.pick(ray, viewer.scene)) ||
        null;
      if (!center) return false;
      const range = Cesium.Cartesian3.distance(camera.positionWC, center);
      const pitch = Cesium.Math.clamp(
        camera.pitch,
        Cesium.Math.toRadians(-89),
        Cesium.Math.toRadians(-15),
      );
      const speed = Cesium.Math.toRadians(settings.idleOrbitDegreesPerSecond);
      let heading = camera.heading;
      let last = now();
      holdContinuousRender(RENDER_OWNER);
      removeFrame = viewer.scene.preRender.addEventListener(() => {
        if (tour || userControl) return;
        const t = now();
        heading += speed * Math.min(0.1, (t - last) / 1000);
        last = t;
        camera.lookAt(
          center,
          new Cesium.HeadingPitchRange(heading, pitch, range),
        );
      });
      return true;
    },

    /** Stop the startup turn (a running tour is left alone). */
    stopIdle() {
      if (!tour) stopFrames();
    },

    destroy() {
      generation++;
      tour = null;
      stopFrames();
      for (const type of listeners)
        canvas.removeEventListener(type, takeover, { capture: true });
    },
  };
}
