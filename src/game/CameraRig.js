import * as THREE from 'three';
import { waveHeight } from '../utils/waves.js';

// 追尾相机：平滑跟随 + 速度感 FOV
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.tmpPos = new THREE.Vector3();
    this.tmpLook = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3();
    this.pos = new THREE.Vector3(0, 10, -15);
    this.look = new THREE.Vector3();
    this.cameraHeading = 0;
    this.heightSmooth = 0; // 艇高度二次平滑：消除波浪导致的相机上下颠簸
    // 附近浪面最高点的平滑值：镜头始终压在浪尖之上，避免船/浮桶被浪挡住
    this.crestLift = 0;
    // 漂移时相机的转向跟随上限（rad/s）。必须在两档之间平滑过渡：
    // 旧版直接三元切换 3.6 ↔ 1.8，漂移一开始相机就"冻"住追角，读起来像卡了一下。
    this.yawClamp = 3.6;
    // 基础视场角（设置里的「视场角」由 Game 写入）：速度/氮气的加成叠在它上面
    this.fovBase = 62;
    // BOSS 锁头镜头结束后（传送门阶段）的慢速交接计时：期间压低转向和跟随速率，
    // 避免镜头从 BOSS 尸体方向瞬间甩回船头前方
    this.relaxT = 0;
    // 赛道面采样器 (x,z) => y|null，由 Game 塞进来（镜头防穿地用）
    this.groundSampler = null;
  }

  /** 由 Game 在锁头镜头消失时调用：接下来 duration 秒内用更慢的转向/跟随 */
  relaxAfterLock(duration = 1.35) {
    // 以当前镜头朝向为起点，避免 cameraHeading 还是开打前的旧角度造成二次甩头
    if (this.camera) {
      const dir = this.camera.getWorldDirection(this.tmpDir);
      this.cameraHeading = Math.atan2(dir.x, dir.z);
    }
    this.relaxT = duration;
  }

  follow(boat, dt, t = 0) {
    const relaxing = this.relaxT > 0;
    if (relaxing) this.relaxT = Math.max(0, this.relaxT - dt);
    const speed = boat.speed || 0;
    const heading = boat.heading;
    // The chase camera is always a forward-facing camera. Do not derive its
    // heading from lateral velocity: during a drift that would swing the view
    // toward the slip vector, and in reverse it would look over the stern.
    const targetHeading = heading;
    let cameraDelta = targetHeading - this.cameraHeading;
    while (cameraDelta > Math.PI) cameraDelta -= Math.PI * 2;
    while (cameraDelta < -Math.PI) cameraDelta += Math.PI * 2;
    // 漂移中相机故意跟得慢一点，甩尾才看得出来；但切换要滑过去，不能一帧跳档
    const clampTarget = relaxing ? 1.6 : (boat.drifting ? 1.8 : 3.6);
    this.yawClamp += (clampTarget - this.yawClamp) * (1 - Math.exp(-9 * dt));
    const maxTurn = this.yawClamp * dt;
    this.cameraHeading += THREE.MathUtils.clamp(cameraDelta, -maxTurn, maxTurn);
    const fx = Math.sin(this.cameraHeading);
    const fz = Math.cos(this.cameraHeading);
    const speedT = Math.min(1, speed / 44);

    const dist = 9.5 + speedT * 2.5 + (boat.def?.camera?.dist || 0);
    const height = 4.2 + speedT * 0.8 + (boat.def?.camera?.height || 0);

    // 艇的波起伏再做一层低通（比船体本身更平缓）→ 相机稳、不晕
    //
    // 但**大落差段必须跟得上**：固定 2.2/s 的低通在瀑布（55m 落差，约 3s 落到底）
    // 和云端爬升（63m）上会让镜头卡在崖顶，艇已经滑到几十米外变成一个小点 ——
    // 用户反馈"瀑布上的镜头根本看不见"就是这个。落差超过 4m 时把跟随速率提到 12/s，
    // 正常巡航仍是原来的平滑度，只有真出现大落差时才"咬住"。
    const dyBoat = boat.pos.y - this.heightSmooth;
    const heightRate = Math.abs(dyBoat) > 4 ? 12 : 2.2;
    this.heightSmooth = THREE.MathUtils.lerp(this.heightSmooth, boat.pos.y, 1 - Math.exp(-heightRate * dt));

    // 浪峰遮挡：同时采样机位、机位与船的中点、船位三处水面，
    // 取最高点让镜头压在浪尖之上（上抬快、回落慢，避免抖动）
    const camX = boat.pos.x - fx * dist;
    const camZ = boat.pos.z - fz * dist;
    const surface = Math.max(
      waveHeight(camX, camZ, t),
      waveHeight((camX + boat.pos.x) * 0.5, (camZ + boat.pos.z) * 0.5, t),
      waveHeight(boat.pos.x, boat.pos.z, t),
    );
    const liftK = 1 - Math.exp(-(surface > this.crestLift ? 5.5 : 1.1) * dt);
    this.crestLift += (surface - this.crestLift) * liftK;

    // 浪峰遮挡只在**水面航行**时生效。船下潜到 -8m 时若还拿 crestLift+3.0 当机位下限，
    // 相机会被硬顶回水面之上，Game 里的 uwK = (0.3 - camera.y)/1.8 恒为 0 ——
    // 蓝绿浓雾 / 气泡 / 鱼群 / 海底布景 / 水面雾 / 后处理吸收全部不会触发，
    // 表现就是「龙宫的水下视角没了」。这里用与 Game 相同的公式算下潜程度，
    // 把水面下限平滑让回船的高度，相机才会跟着艇一起没入水面。
    const uw = THREE.MathUtils.clamp((0.3 - this.heightSmooth) / 1.8, 0, 1);
    const camY = this.heightSmooth + height;
    const lookY = this.heightSmooth + 1.2;
    const surfaceFloor = THREE.MathUtils.lerp(this.crestLift + 3.0, camY, uw);
    const surfaceLook = THREE.MathUtils.lerp(this.crestLift + 0.4, lookY, uw);

    this.tmpPos.set(
      camX,
      Math.max(camY, surfaceFloor),
      camZ,
    );
    // 机位不许钻到赛道面以下：回程和瀑布段的地形/水面向来贴着赛道，
    // 镜头一旦落到赛道面下，看到的就是一条黑色的背面（用户截图里那片全黑）。
    // 只在"赛道面和船差不多高"时才抬 —— 瀑布下坠时赛道面在船下方几十米，
    // 拿它当最低点会把镜头挂在崖顶，那就又变成"看不见船"了。
    let camFloor = -Infinity;
    if (this.groundSampler) {
      const gy = this.groundSampler(this.tmpPos.x, this.tmpPos.z);
      if (gy != null && Number.isFinite(gy) && Math.abs(gy - boat.pos.y) < 8) camFloor = gy + 2.0;
    }
    if (this.tmpPos.y < camFloor) this.tmpPos.y = camFloor;
    this.tmpLook.set(
      boat.pos.x + fx * 8,
      Math.max(lookY, surfaceLook),
      boat.pos.z + fz * 8,
    );

    const k = 1 - Math.exp(-(relaxing ? 2.2 : 6) * dt);
    this.pos.lerp(this.tmpPos, k);
    // 视线方向的跟随同样放慢，避免注视点在船与尸体之间快速扫过
    this.look.lerp(this.tmpLook, 1 - Math.exp(-(relaxing ? 2.6 : 6) * dt));
    // 低通之后的真实机位也要夹一次，否则过渡期里仍会短暂穿到赛道面下
    if (this.pos.y < camFloor) this.pos.y = camFloor;

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);

    // 速度感：FOV 微增；氮气/加速中额外拉宽（冲刺感）
    const boosting = boat.boostTimer > 0 ? 1 : 0;
    const targetFov = this.fovBase + speedT * 6 + boosting * 3;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, k);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 打 BOSS 专用：保留追尾镜头的低机位（不是俯视），但镜头始终对准怪物。
   * 机位放在「怪物 → 船」方向的延长线上，所以玩家左右绕行时镜头只平移，
   * 不会跟着船头摆来摆去；船一直在画面下方，BOSS 始终在正前方。
   */
  followLookAt(boat, target, dt) {
    const dx = boat.pos.x - target.x;
    const dz = boat.pos.z - target.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    const speed = boat.speed || 0;
    const speedT = Math.min(1, speed / 44);

    // 巨物/BOSS 模式：同一套追尾机位，可以按艇型退后抬高（竖着站的角色赛艇
    // 比平放的船高一大截，不拉开一点会糊住半个画面）
    const dist = 10.5 + speedT * 2.5 + (boat.def?.camera?.dist || 0);
    const height = 4.6 + speedT * 0.8 + (boat.def?.camera?.height || 0);

    this.heightSmooth = THREE.MathUtils.lerp(this.heightSmooth, boat.pos.y, 1 - Math.exp(-2.2 * dt));

    this.tmpPos.set(
      boat.pos.x + fx * dist,
      this.heightSmooth + height,
      boat.pos.z + fz * dist,
    );
    this.tmpLook.set(target.x, target.y, target.z);

    const k = 1 - Math.exp(-6 * dt);
    this.pos.lerp(this.tmpPos, k);
    this.look.lerp(this.tmpLook, 1 - Math.exp(-9 * dt));

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);

    const boosting = boat.boostTimer > 0 ? 1 : 0;
    const targetFov = this.fovBase + speedT * 6 + boosting * 3;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, k);
    this.camera.updateProjectionMatrix();
  }

  /** 过场结束时从当前机位接管，避免追尾相机从旧位置拉一大段 */
  adopt(camera) {
    this.pos.copy(camera.position);
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    this.look.copy(camera.position).addScaledVector(dir, 20);
  }

  focusPodium(group, dt) {
    const heading = group.rotation.y;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const center = group.position;
    const targetPos = this.tmpPos.set(
      center.x - fx * 14,
      center.y + 6.2,
      center.z - fz * 14,
    );
    const targetLook = this.tmpLook.set(center.x, center.y + 1.35, center.z);
    const k = 1 - Math.exp(-4.5 * dt);
    // 颁奖台在地图另一端的仪式海域：距离太远直接切机位，
    // 避免低帧率下镜头横穿整张地图拖出一条很长的飞行过程
    if (this.pos.distanceTo(targetPos) > 40) {
      this.pos.copy(targetPos);
      this.look.copy(targetLook);
    } else {
      this.pos.lerp(targetPos, k);
      this.look.lerp(targetLook, k);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.fovBase - 10, k);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 完赛特写：贴近赛艇、缓慢环绕（此时玩家已不能操控）。
   * 机位从船侧后方起绕，半径固定，镜头始终锁在船身上——右侧留给结算面板。
   */
  focusFinish(boat, dt, elapsed, t = 0) {
    const radius = 8.4;
    const ang = boat.heading + Math.PI + 0.6 + elapsed * 0.26; // ≈24 秒一圈
    const cx = boat.pos.x;
    const cz = boat.pos.z;
    const cy = Number.isFinite(boat.pos.y) ? boat.pos.y : 0;
    const camX = cx + Math.sin(ang) * radius;
    const camZ = cz + Math.cos(ang) * radius;
    // 环绕时也可能被浪尖挡住：机位压在环内最高浪面之上
    const surface = Math.max(
      waveHeight(camX, camZ, t),
      waveHeight((camX + cx) * 0.5, (camZ + cz) * 0.5, t),
      waveHeight(cx, cz, t),
    );
    const targetPos = this.tmpPos.set(
      camX,
      Math.max(cy + 2.7, surface + 2.6),
      camZ,
    );
    // 注视点向右偏移一点：赛艇落在画面左侧约 1/3 处，
    // 右侧留给结算面板，任何机位都不会把船压到面板底下。
    const rightX = Math.cos(ang);
    const rightZ = -Math.sin(ang);
    const targetLook = this.tmpLook.set(
      cx + rightX * 2.6,
      cy + 1.15,
      cz + rightZ * 2.6,
    );
    const k = 1 - Math.exp(-3.0 * dt);
    this.pos.lerp(targetPos, k);
    this.look.lerp(targetLook, 1 - Math.exp(-5.5 * dt));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.fovBase - 6, k);
    this.camera.updateProjectionMatrix();
  }

  snapTo(boat) {
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    this.cameraHeading = boat.heading;
    this.heightSmooth = boat.pos.y;
    this.crestLift = boat.pos.y;
    this.pos.set(boat.pos.x - fx * 10, boat.pos.y + 4.5, boat.pos.z - fz * 10);
    this.look.set(boat.pos.x, boat.pos.y + 1, boat.pos.z);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }
}
