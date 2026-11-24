// 深渊积分：海克斯模式每局结束（通关 / 失败 / 领奖）按到达层数与评级结算，
// 存在 localStorage。先只做“有收获”这一层，商城等后续版本再接。
const KEY = 'boat.hexPoints.v1';
const GRADE_BONUS = { S: 120, A: 80, B: 40, C: 10 };

function safeRead() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return {
      total: Math.max(0, Number(raw.total) || 0),
      bestStage: Math.max(0, Number(raw.bestStage) || 0),
      runs: Math.max(0, Number(raw.runs) || 0),
    };
  } catch {
    return null;
  }
}

export function readHexPoints() {
  return safeRead() || { total: 0, bestStage: 0, runs: 0 };
}

/**
 * 结算一局海克斯：
 * @param {object} opts
 * @param {number} opts.stage 本局到达的层数（1 起）
 * @param {boolean} opts.won 是否通关（失败/主动领奖都是 false）
 * @param {string} opts.grade 本局最好评级 S/A/B/C
 * @returns {{points:number,total:number,bestStage:number}}
 */
export function awardHexPoints({ stage = 0, won = false, grade = 'C' } = {}) {
  // 失败时这一层没打完，只算已经通过的层
  const cleared = Math.max(0, won ? stage : stage - 1);
  const gradeBonus = GRADE_BONUS[grade] || GRADE_BONUS.C;
  const points = cleared * 100 + gradeBonus + (won ? 250 : 0);

  const state = readHexPoints();
  state.total += points;
  state.runs += 1;
  state.bestStage = Math.max(state.bestStage, stage);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 隐私模式/存储已满时只丢存档，不打断结算
  }
  return { points, total: state.total, bestStage: state.bestStage };
}
