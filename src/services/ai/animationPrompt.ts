/**
 * 生成角色动作 Sprite Sheet 提示词，并统一帧数、动作阶段和画面比例约束。
 */
import type { AnimationAction } from '../../types';
import { ANIMATION_ACTION_LABELS, ANIMATION_FRAME_GRIDS } from '../../types';
import type { AnimationProcessing } from '../../types/animation';

export type AnimationFrameCount = 6 | 8 | 10 | 12 | 16 | 20;

const ANIMATION_ACTION_PROMPTS: Record<AnimationAction, string> = {
  idle: '原地自然待机循环，只有轻微呼吸、重心起伏和附属物延迟摆动，双脚始终稳定着地',
  walk: '原地行走循环，左右腿交替完成触地、承重、经过和摆出；手臂与对侧腿反向摆动，脚掌沿连续弧线运动且不滑步',
  run: '原地奔跑循环，左右腿交替完成触地、压低、蹬地、腾空和回收；手臂与对侧腿反向摆动，必须出现清晰腾空相位',
  jump: '一次完整跳跃，依次为预备下蹲、蹬地、上升、最高点、下落、触地缓冲和恢复站姿',
  attack: '一次清晰攻击，依次为预备蓄力、加速出招、命中极点、惯性跟随和收势恢复，武器或拳脚轨迹连续',
  hit: '一次短促受击，依次为接触冲击、身体后仰、肢体惯性、最大位移和重心恢复，受力方向始终一致',
  custom: '严格按照用户提示词描述的自定义动作、方向和先后顺序演绎，不替换为待机、行走或其他预设动作',
};

const EIGHT_FRAME_PHASE_GUIDES: Record<AnimationAction, string> = {
  idle: '第1帧中立；第2帧吸气微抬；第3帧继续上升；第4帧最高；第5帧回落；第6帧呼气微沉；第7帧最低；第8帧回到中立前一刻并自然衔接第1帧。',
  walk: '第1帧左脚前触地、右臂前摆；第2帧左腿承重且身体最低；第3帧右脚从身体下方经过；第4帧右脚向前摆、左脚蹬地；第5帧右脚前触地、左臂前摆；第6帧右腿承重且身体最低；第7帧左脚从身体下方经过；第8帧左脚向前摆、右脚蹬地并衔接第1帧。',
  run: '第1帧左脚触地、右臂前摆；第2帧左腿压低承重；第3帧左腿蹬地、右腿从身体下方经过；第4帧腾空回收并准备右脚落地；第5帧右脚触地、左臂前摆；第6帧右腿压低承重；第7帧右腿蹬地、左腿从身体下方经过；第8帧腾空回收并准备衔接第1帧。',
  jump: '第1帧站稳；第2帧预备下蹲；第3帧蹬地离地；第4帧快速上升；第5帧最高点收腿；第6帧下落伸腿；第7帧触地深蹲缓冲；第8帧起身恢复。',
  attack: '第1帧警戒；第2帧重心后移蓄力；第3帧开始加速；第4帧出招途中；第5帧命中极点；第6帧惯性跟随；第7帧收回；第8帧接近警戒姿势。',
  hit: '第1帧正常姿势；第2帧刚受冲击；第3帧快速后仰；第4帧肢体继续惯性摆动；第5帧最大后移；第6帧开始回稳；第7帧重心归位；第8帧接近正常姿势。',
  custom: '根据用户描述安排动作阶段，将完整动作均匀采样为8个连续且不重复的时间点，严格保持用户指定的顺序。',
};

const ANIMATION_SHEET_RATIOS: Record<AnimationFrameCount, string> = {
  6: '3:2',
  8: '2:1',
  10: '21:9',
  12: '4:3',
  16: '1:1',
  20: '5:4',
};

// 即梦只接受固定比例；选最接近宫格比例的宽幅尺寸，避免退回 1:1 后把 4×2 单元格拉成长条。
const DREAMINA_ANIMATION_SHEET_RATIOS: Partial<Record<AnimationFrameCount, string>> = {
  8: '16:9',
  20: '4:3',
};

const LOOPING_ACTIONS = new Set<AnimationAction>(['idle', 'walk', 'run']);

export function resolveAnimationSheetAspectRatio(
  frameCount: AnimationFrameCount,
  provider: string,
) {
  return provider === 'dreamina'
    ? DREAMINA_ANIMATION_SHEET_RATIOS[frameCount] ?? ANIMATION_SHEET_RATIOS[frameCount]
    : ANIMATION_SHEET_RATIOS[frameCount];
}

/**
 * 换皮提示词：已生成的 Sprite Sheet 当姿势母版，只换角色外观。
 * 返回的是「角色描述」段，仍需交给 buildAnimationSpritePrompt 包上宫格与一致性约束。
 */
export function buildAnimationReskinPrompt(
  sheetMention: string,
  skinMentions: readonly string[],
) {
  return [
    `【换皮】${sheetMention} 是原动作 Sprite Sheet 宫格图，只提供姿势与骨骼；${skinMentions.join('、')} 是新角色形象图，只提供外观。`,
    '【姿势对齐】逐格严格复制原宫格同一位置格子的姿势、朝向、关节角度、重心高度、脚底基线和画面站位，格数与排布完全一致；不得重新编排动作、增删帧、调换顺序或镜像。',
    '【外观替换】把角色的造型、配色、服装、发型、材质和附属物整体换成新角色形象；新角色的披风、武器、尾巴等附属物挂在对应肢体锚点上，跟随同一姿势连续运动。',
    '【比例适配】新角色头身比与原角色不同时按新角色自身比例重绘，但角色总高度、脚底基线和在单元格中的占比与原宫格保持一致。',
  ].join('\n');
}

export function buildAnimationSpritePrompt(
  characterPrompt: string,
  action: AnimationAction,
  frameCount: AnimationFrameCount,
  sheetAspectRatio: string,
  processing?: Pick<AnimationProcessing, 'chromaKey' | 'ground' | 'margin'>,
) {
  const grid = ANIMATION_FRAME_GRIDS[frameCount];
  const safeMargin = Math.round((processing?.margin ?? 0.1) * 100);
  const playbackConstraint = action === 'custom'
    ? '按用户描述决定循环或一次性动作；要求循环时末帧自然衔接首帧，否则完整呈现起势、动作过程与结束姿势。每帧按时间推进，不得交换、倒序或重复关键姿势。'
    : LOOPING_ACTIONS.has(action)
    ? '这是循环动作：不要复制首帧作为末帧；末帧必须处在回到首帧之前的连续相位，播放时无停顿、跳变或脚底滑动。'
    : '这是一次性动作：每帧必须按时间推进，不得交换、倒序或重复关键姿势。';

  return [
    characterPrompt.trim(),
    '【参考职责】角色参考图是身份与美术风格的唯一来源：逐帧复制头身比、像素密度、描边粗细、调色板、服装与细节密度，不重新设计角色，不用通用 Q 版风格替代参考。已有动作宫格仅提供动作、时序和站位；换皮时新角色图负责外观，旧宫格负责姿势。',
    action === 'custom'
      ? '【身份锚点】锁定相机高度和透视；角色朝向仅按用户描述连续变化，允许动作需要的转身。发卡、耳饰、疤痕、单侧图案及持物手始终属于同一身体侧，不得镜像或随姿势换边；动作不能改变角色身份。'
      : '【身份锚点】锁定同一朝向、相机高度和透视；发卡、耳饰、疤痕、单侧图案及持物手始终属于同一身体侧，不得镜像或随姿势换边。把变化集中在动作上，宁可动作幅度较小也不要改变角色身份。',
    `【任务】生成 ${ANIMATION_ACTION_LABELS[action]} 动画 Sprite Sheet。这是同一个角色的连续动画技术图，不是多个不同姿势的角色拼贴。`,
    `【动作机制】${ANIMATION_ACTION_PROMPTS[action]}。${playbackConstraint}`,
    frameCount === 8 ? `【8帧时间轴】${EIGHT_FRAME_PHASE_GUIDES[action]}` : `【时间轴】将完整动作均匀采样为 ${frameCount} 个连续且不重复的时间点。`,
    `【画布与宫格】整张图比例严格为 ${sheetAspectRatio}，共 ${frameCount} 帧，严格按从左到右、从上到下排列为 ${grid.cols} 列 × ${grid.rows} 行；铺满画布，所有单元格等宽等高，不留大面积外边距、行间距或列间距。`,
    `【坐标锚点】把每个隐形单元格看作独立的 0–100% 坐标系：角色身体主轴固定在 x=50%，地面基线固定在 y=${100 - safeMargin}%；安全边距至少 ${safeMargin}%。手臂、武器和披风伸展不能带着躯干偏离主轴，不用包含武器的外接框中心代替身体中心。`,
    (processing?.ground ?? action !== 'jump')
      ? '【接地】所有帧保持同一地面基线；行走/奔跑中正在承重的脚落在该线，腾空相位与下蹲的高度变化必须来自真实动作，不能改变角色比例。'
      : '【纵向轨迹】保持地面基线与画幅固定，通过角色身体在格子内的真实上下位移表现跳跃；保留离地高度，不把腾空帧重新贴到地面，不逐帧放大收腿或下蹲的姿势。',
    processing?.chromaKey === 'none'
      ? '【背景】使用真实透明 Alpha 背景，不绘制棋盘格、阴影或场景。'
      : `【背景】整张图使用均匀纯${processing?.chromaKey === 'green' ? '绿色 #00FF00' : '品红色 #FF00FF'}键控底色；角色、饰物和高光避免该键控色。禁止棋盘格、渐变、投影、地面阴影、光晕、浮空粒子和与身体分离的碎片。`,
    '【尺寸锁定】每格中的角色使用完全相同的绘制比例、头身比和透视，躯干大小及四肢长度固定；中立站姿的角色主体约占单元格高度的 78%，以同一地面基线与身体中心轴作为固定参照，允许动作需要的下蹲、腾空和上下位移，不得逐帧放大、缩小、拉宽或压扁。',
    action === 'custom'
      ? '【骨骼连续性】锁定左右手、左右脚及关节身份，肢体沿合理的连续轨迹运动，手脚配合遵循用户描述的动作。手脚必须连接身体，不得换边、镜像、瞬移、折断、增生或消失；服装、背包、武器、尾巴等附属物跟随同一身体锚点连续运动。'
      : '【骨骼连续性】锁定左右手、左右脚及关节身份，肢体只能沿连续圆弧运动；左腿向前时右臂向前，右腿向前时左臂向前。手脚必须连接身体，不得换边、镜像、瞬移、折断、增生或消失；服装、背包、武器、尾巴等附属物必须跟随同一身体锚点连续运动。',
    action === 'custom'
      ? '【一致性】每帧保持完全相同的角色造型、相机角度、配色、线条、光照和背景，朝向及姿态轮廓按用户描述连续变化；角色完整位于各自单元格安全区内，不得越界或被裁切。'
      : '【一致性】每帧保持完全相同的角色造型、朝向、相机角度、轮廓、配色、线条、光照和背景；角色完整位于各自单元格安全区内，不得越界或被裁切。',
    '【禁止】不要文字、编号、边框、分隔线、额外角色、重复帧、镜像帧、视角变化、绘制出的轨迹线、运动残影或速度线。',
  ].join('\n');
}
