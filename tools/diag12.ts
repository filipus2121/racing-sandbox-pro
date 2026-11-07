import { GT3_VENOM, defaultSetup, defaultEnvironment } from '../src/physics/cars.js';
import { Vehicle, stepVehicle, NEUTRAL_SURFACE } from '../src/physics/vehicle.js';
const dt = 1 / 500;
const setup = defaultSetup(GT3_VENOM);
const c = new Vehicle(GT3_VENOM, setup);
for (let i = 0; i < 4; i++) { c.setSurface(i, { ...NEUTRAL_SURFACE }); c.tyres[i].coreTemp = 92; c.tyres[i].surfaceTemp = 92; }
c.place(0, 0, 0, 0); c.gear = 1; c.rpm = GT3_VENOM.engine.idleRpm;
const inp = { throttle: 1, brake: 0, steer: 0, clutch: 0, shiftUp: false, shiftDown: false, handbrake: 0 };
let shiftHold = 0;
for (let i = 0; i < 10 / dt; i++) {
  inp.shiftUp = false;
  if (shiftHold <= 0 && c.rpm > GT3_VENOM.engine.redlineRpm * 0.93 && c.gear < c.gearCount()) { inp.shiftUp = true; shiftHold = 0.06; }
  shiftHold -= dt;
  stepVehicle(c, inp, defaultEnvironment, dt);
  if (i % 500 === 0) {
    let sfx = 0, sfy = 0;
    for (const w of c.wheels) { sfx += w.fx; sfy += w.fy; }
    console.log('t', (i*dt).toFixed(1), 'v', c.speed.toFixed(2), 'kmh', (c.speed*3.6).toFixed(1),
      'gear', c.gear, 'rpm', Math.round(c.rpm),
      'sumFx', sfx.toFixed(0), 'sumFy', sfy.toFixed(0),
      'fx[FL,FR,RL,RR]', c.wheels.map(w=>w.fx.toFixed(0)).join(','),
      'yaw', c.yawRate.toFixed(3), 'hdg', c.heading.toFixed(3),
      'aL', c.accelLong.toFixed(2), 'aLat', c.accelLat.toFixed(2));
  }
}
