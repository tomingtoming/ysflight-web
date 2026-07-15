// YSFLIGHT .dat keyword schema — sourced from
// upstream/YSFLIGHT/src/vehicle/fsairplaneproperty.cpp keyWordSource[] (lines 7838-8146).
// Index order matches the C++ array exactly so *N short-format ids stay stable.
//
// Fields:
//   kw    - keyword string (8 chars max)
//   args  - expected argument count: 0 = none, 1 = scalar/bool, 3 = vec3/att3,
//            6 = TURRETPO (id x y z h p b), -1 = variable
//   type  - 'bool'|'force'|'weight'|'speed'|'angle'|'length'|'area'|
//            'scalar'|'int'|'string'|'vec3'|'att3'|'text'|'other'
//   unit  - hint string shown next to the field ('' = dimensionless)
//   cat   - UI category grouping
//   ja    - one-line Japanese description
//   en    - one-line English description

export const DAT_SCHEMA = [
  // --- 0 ---
  { kw: 'AFTBURNR', args: 1, type: 'bool',   unit: '',     cat: 'engine',  ja: 'アフターバーナーあり',                    en: 'Has afterburner' },
  { kw: 'THRAFTBN', args: 1, type: 'force',  unit: 'N',    cat: 'engine',  ja: 'アフターバーナー時推力',                  en: 'Thrust with afterburner' },
  { kw: 'THRMILIT', args: 1, type: 'force',  unit: 'N',    cat: 'engine',  ja: 'ミリタリー推力',                          en: 'Military thrust' },
  { kw: 'WEIGHCLN', args: 1, type: 'weight', unit: 'kg',   cat: 'weight',  ja: 'クリーン重量',                            en: 'Clean weight' },
  { kw: 'WEIGFUEL', args: 1, type: 'weight', unit: 'kg',   cat: 'weight',  ja: '燃料最大重量',                            en: 'Max fuel weight' },
  { kw: 'WEIGLOAD', args: 1, type: 'weight', unit: 'kg',   cat: 'weight',  ja: 'ペイロード最大重量',                      en: 'Max payload weight' },
  { kw: 'FUELABRN', args: 1, type: 'weight', unit: 'kg/s', cat: 'engine',  ja: 'アフターバーナー時燃料消費率',            en: 'Fuel consumption (afterburner)' },
  { kw: 'FUELMILI', args: 1, type: 'weight', unit: 'kg/s', cat: 'engine',  ja: 'ミリタリー時燃料消費率',                  en: 'Fuel consumption (military)' },
  // --- 8 ---
  { kw: 'LEFTGEAR', args: 3, type: 'vec3',   unit: 'm',    cat: 'gear',    ja: '左メインギア位置',                        en: 'Left main gear position' },
  { kw: 'RIGHGEAR', args: 3, type: 'vec3',   unit: 'm',    cat: 'gear',    ja: '右メインギア位置',                        en: 'Right main gear position' },
  { kw: 'WHELGEAR', args: 3, type: 'vec3',   unit: 'm',    cat: 'gear',    ja: '前輪（ノーズギア）位置',                  en: 'Wheel (nose gear) position' },
  // --- 11 ---
  { kw: 'CRITAOAP', args: 1, type: 'angle',  unit: 'rad',  cat: 'aero',    ja: '失速迎角（正）',                          en: 'Critical angle of attack (positive)' },
  { kw: 'CRITAOAM', args: 1, type: 'angle',  unit: 'rad',  cat: 'aero',    ja: '失速迎角（負）',                          en: 'Critical angle of attack (negative)' },
  { kw: 'CRITSPED', args: 1, type: 'speed',  unit: 'm/s',  cat: 'aero',    ja: '臨界速度',                                en: 'Critical speed' },
  { kw: 'MAXSPEED', args: 1, type: 'speed',  unit: 'm/s',  cat: 'aero',    ja: '最高速度',                                en: 'Maximum airspeed' },
  // --- 15 ---
  { kw: 'HASSPOIL', args: 1, type: 'bool',   unit: '',     cat: 'aero',    ja: 'スポイラーあり',                          en: 'Has spoiler' },
  { kw: 'RETRGEAR', args: 1, type: 'bool',   unit: '',     cat: 'gear',    ja: '引込脚あり',                              en: 'Has retractable gear' },
  { kw: 'VARGEOMW', args: 1, type: 'bool',   unit: '',     cat: 'aero',    ja: '可変翼あり',                              en: 'Has variable geometry wing' },
  // --- 18 ---
  { kw: 'CLVARGEO', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: '可変翼展開時のCL増加量',                  en: 'CL increase when VGW extended' },
  { kw: 'CDVARGEO', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: '可変翼展開時のCD増加量',                  en: 'CD increase when VGW extended' },
  { kw: 'CLBYFLAP', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'フラップ全開時のCL増加量',                en: 'CL increase when flap full down' },
  { kw: 'CDBYFLAP', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'フラップ全開時のCD増加量',                en: 'CD increase when flap full down' },
  { kw: 'CDBYGEAR', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'ギア展開時のCD増加量',                    en: 'CD increase when gear down' },
  { kw: 'CDSPOILR', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'スポイラー展開時のCD増加量',              en: 'CD increase when spoiler deployed' },
  // --- 24 ---
  { kw: 'WINGAREA', args: 1, type: 'area',   unit: 'm²', cat: 'aero', ja: '翼面積',                                  en: 'Wing area' },
  // --- 25 ---
  { kw: 'MXIPTAOA', args: 1, type: 'angle',  unit: 'rad',  cat: 'control', ja: '最大入力迎角',                            en: 'Max input angle of attack' },
  { kw: 'MXIPTSSA', args: 1, type: 'angle',  unit: 'rad',  cat: 'control', ja: '最大入力横滑り角',                        en: 'Max input sideslip angle' },
  { kw: 'MXIPTROL', args: 1, type: 'angle',  unit: 'rad',  cat: 'control', ja: '最大入力ロール角',                        en: 'Max input roll ratio' },
  // --- 28 ---
  { kw: 'CPITMANE', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ピッチ機動性定数',                        en: 'Pitch maneuverability constant' },
  { kw: 'CPITSTAB', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ピッチ安定性定数',                        en: 'Pitch stability constant' },
  { kw: 'CYAWMANE', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ヨー機動性定数',                          en: 'Yaw maneuverability constant' },
  { kw: 'CYAWSTAB', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ヨー安定性定数',                          en: 'Yaw stability constant' },
  { kw: 'CROLLMAN', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ロール機動性定数',                        en: 'Roll maneuverability constant' },
  // --- 33 ---
  { kw: 'CTLLDGEA', args: 1, type: 'bool',   unit: '',     cat: 'init',    ja: '初期ギア位置（TRUE=展開）',               en: 'Initial gear (TRUE=down)' },
  { kw: 'CTLBRAKE', args: 1, type: 'bool',   unit: '',     cat: 'init',    ja: '初期ブレーキ',                            en: 'Initial brake' },
  { kw: 'CTLSPOIL', args: 1, type: 'scalar', unit: '',     cat: 'init',    ja: '初期スポイラー量 (0-1)',                   en: 'Initial spoiler (0-1)' },
  { kw: 'CTLABRNR', args: 1, type: 'bool',   unit: '',     cat: 'init',    ja: '初期アフターバーナー',                    en: 'Initial afterburner' },
  { kw: 'CTLTHROT', args: 1, type: 'scalar', unit: '',     cat: 'init',    ja: '初期スロットル量 (0-1)',                   en: 'Initial throttle (0-1)' },
  { kw: 'CTLIFLAP', args: 1, type: 'scalar', unit: '',     cat: 'init',    ja: '初期フラップ量 (0-1)',                     en: 'Initial flap (0-1)' },
  { kw: 'CTLINVGW', args: 1, type: 'scalar', unit: '',     cat: 'init',    ja: '初期可変翼量 (0-1)',                       en: 'Initial VGW (0-1)' },
  { kw: 'CTLATVGW', args: 1, type: 'bool',   unit: '',     cat: 'init',    ja: '初期自動可変翼',                          en: 'Initial auto VGW' },
  // --- 41 ---
  { kw: 'POSITION', args: 3, type: 'vec3',   unit: 'm',    cat: 'init',    ja: '初期位置',                                en: 'Initial position' },
  { kw: 'ATTITUDE', args: 3, type: 'att3',   unit: 'deg',  cat: 'init',    ja: '初期姿勢 (H P B)',                        en: 'Initial attitude (H P B)' },
  { kw: 'INITFUEL', args: 1, type: 'weight', unit: 'kg',   cat: 'init',    ja: '初期燃料重量',                            en: 'Initial fuel weight' },
  { kw: 'INITLOAD', args: 1, type: 'weight', unit: 'kg',   cat: 'init',    ja: '初期ペイロード重量',                      en: 'Initial payload weight' },
  { kw: 'INITSPED', args: 1, type: 'speed',  unit: 'm/s',  cat: 'init',    ja: '初期速度',                                en: 'Initial speed' },
  // --- 46 ---
  { kw: 'REFVCRUS', args: 1, type: 'speed',  unit: 'm/s',  cat: 'perf',    ja: '巡航速度',                                en: 'Reference cruise speed' },
  { kw: 'REFACRUS', args: 1, type: 'length', unit: 'm',    cat: 'perf',    ja: '巡航高度',                                en: 'Reference cruise altitude' },
  { kw: 'REFVLAND', args: 1, type: 'speed',  unit: 'm/s',  cat: 'perf',    ja: '着陸速度',                                en: 'Reference landing speed' },
  { kw: 'REFAOALD', args: 1, type: 'angle',  unit: 'rad',  cat: 'perf',    ja: '着陸進入迎角',                            en: 'AOA while approaching to land' },
  { kw: 'REFLNRWY', args: 1, type: 'length', unit: 'm',    cat: 'perf',    ja: '着陸必要滑走路長',                        en: 'Runway length required to land' },
  // --- 51 ---
  { kw: 'REM',      args: -1, type: 'text',  unit: '',     cat: 'meta',    ja: 'コメント行',                              en: 'Comment line' },
  // --- 52 ---
  { kw: 'COCKPITP', args: 3, type: 'vec3',   unit: 'm',    cat: 'cockpit', ja: 'コックピット位置',                        en: 'Cockpit eye position' },
  { kw: 'REFTHRLD', args: 1, type: 'scalar', unit: '',     cat: 'perf',    ja: '着陸参照スロットル',                      en: 'Reference throttle for landing' },
  { kw: 'REFTCRUS', args: 1, type: 'scalar', unit: '',     cat: 'perf',    ja: '巡航参照スロットル',                      en: 'Reference throttle for cruise' },
  // --- 55 ---
  { kw: 'AUTOCALC', args: 0, type: 'bool',   unit: '',     cat: 'meta',    ja: '自動計算有効',                            en: 'Enable auto-calculation' },
  // --- 56 ---
  { kw: 'IDENTIFY', args: -1, type: 'string', unit: '',    cat: 'id',      ja: '機体識別名',                              en: 'Aircraft identity string' },
  // --- 57 ---
  { kw: 'MANESPD1', args: 1, type: 'speed',  unit: 'm/s',  cat: 'perf',    ja: '最低機動速度',                            en: 'Minimum maneuverable speed' },
  { kw: 'MANESPD2', args: 1, type: 'speed',  unit: 'm/s',  cat: 'perf',    ja: '完全機動速度',                            en: 'Fully maneuverable speed' },
  // --- 59 ---
  { kw: 'MACHNGUN', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃マウント位置',                        en: 'Machine gun mount position' },
  { kw: 'SMOKEGEN', args: 3, type: 'vec3',   unit: 'm',    cat: 'smoke',   ja: 'スモーク発生位置',                        en: 'Smoke generator position' },
  { kw: 'HTRADIUS', args: 1, type: 'length', unit: 'm',    cat: 'weapon',  ja: 'ヒット判定半径',                          en: 'Hit radius' },
  { kw: 'TRIGGER1', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'トリガー1 設定',                          en: 'Trigger 1 configuration' },
  { kw: 'TRIGGER2', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'トリガー2 設定',                          en: 'Trigger 2 configuration' },
  { kw: 'TRIGGER3', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'トリガー3 設定',                          en: 'Trigger 3 configuration' },
  { kw: 'TRIGGER4', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'トリガー4 設定',                          en: 'Trigger 4 configuration' },
  // --- 66 ---
  { kw: 'STRENGTH', args: 1, type: 'int',    unit: '',     cat: 'meta',    ja: '耐久力',                                  en: 'Toughness / hit points' },
  // --- 67 ---
  { kw: 'PROPELLR', args: -1, type: 'other', unit: '',     cat: 'engine',  ja: 'プロペラ設定',                            en: 'Propeller configuration' },
  // --- 68 ---
  { kw: 'VAPORPO0', args: 3, type: 'vec3',   unit: 'm',    cat: 'smoke',   ja: 'ベーパー位置0（翼後退時）',               en: 'Vapor trail position 0 (wings swept)' },
  { kw: 'VAPORPO1', args: 3, type: 'vec3',   unit: 'm',    cat: 'smoke',   ja: 'ベーパー位置1（翼展開時）',               en: 'Vapor trail position 1 (wings spread)' },
  // --- 70 ---
  { kw: 'INITIGUN', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期機銃弾数',                            en: 'Initial gun bullet count' },
  { kw: 'INITIAAM', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期AAM数',                               en: 'Initial AAM count' },
  { kw: 'INITIAGM', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期AGM数',                               en: 'Initial AGM count' },
  // --- 73 ---
  { kw: 'MANESPD3', args: 1, type: 'speed',  unit: 'm/s',  cat: 'perf',    ja: '第3機動速度参照',                         en: 'Maneuverable speed reference 3' },
  // --- 74 ---
  { kw: 'RADARCRS', args: 1, type: 'scalar', unit: '',     cat: 'meta',    ja: 'レーダー断面積（RCS）',                   en: 'Radar cross-section' },
  // --- 75 ---
  { kw: 'MACHNGN2', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃2マウント位置',                       en: 'Machine gun 2 mount position' },
  // --- 76 ---
  { kw: 'SMOKEOIL', args: -1, type: 'other', unit: '',     cat: 'smoke',   ja: 'オイルスモーク設定',                      en: 'Oil smoke configuration' },
  { kw: 'WEAPONCH', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'ウェポンチャンネル設定',                  en: 'Weapon channel configuration' },
  { kw: 'INITBOMB', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期爆弾数',                              en: 'Initial bomb count' },
  // --- 79 ---
  { kw: 'MONTRILS', args: 1, type: 'bool',   unit: '',     cat: 'smoke',   ja: 'モータートレイル有効',                    en: 'Motor trails enabled' },
  // --- 80 ---
  { kw: 'GUNPOWER', args: 1, type: 'scalar', unit: '',     cat: 'weapon',  ja: '機銃威力',                                en: 'Gun power' },
  // --- 81 ---
  { kw: 'CATEGORY', args: 1, type: 'string', unit: '',     cat: 'id',      ja: '機体カテゴリ',                            en: 'Aircraft category (FIGHTER/ATTACKER/…)' },
  // --- 82 ---
  { kw: 'VGWSPED1', args: 1, type: 'speed',  unit: 'm/s',  cat: 'aero',    ja: '自動可変翼低速側参照速度',                en: 'Auto-VGW slower reference speed' },
  { kw: 'VGWSPED2', args: 1, type: 'speed',  unit: 'm/s',  cat: 'aero',    ja: '自動可変翼高速側参照速度',                en: 'Auto-VGW faster reference speed' },
  // --- 84 ---
  { kw: 'GUNDIREC', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: '機銃発射方向',                            en: 'Gun firing direction' },
  // --- 85 ---
  { kw: 'INITRCKT', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期ロケット数',                          en: 'Initial rocket count' },
  { kw: 'MAXNMGUN', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大機銃弾数',                            en: 'Max gun bullet count' },
  { kw: 'MAXNMAAM', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大AAM数（廃止）',                       en: 'Max AAM count (deprecated)' },
  { kw: 'MAXNMAGM', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大AGM数（廃止）',                       en: 'Max AGM count (deprecated)' },
  { kw: 'MAXNMRKT', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大ロケット数（廃止）',                  en: 'Max rocket count (deprecated)' },
  // --- 90 ---
  { kw: 'AAMSLOT_', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'AAMスロット定義',                         en: 'AAM slot definition' },
  { kw: 'AGMSLOT_', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'AGMスロット定義',                         en: 'AGM slot definition' },
  { kw: 'RKTSLOT_', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'ロケットスロット定義',                    en: 'Rocket slot definition' },
  { kw: 'BOMBSLOT', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: '爆弾スロット定義',                        en: 'Bomb slot definition' },
  { kw: 'AAMVISIB', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: 'AAM表示',                                 en: 'AAM visible' },
  { kw: 'AGMVISIB', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: 'AGM表示',                                 en: 'AGM visible' },
  { kw: 'BOMVISIB', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: '爆弾表示',                                en: 'Bomb visible' },
  { kw: 'RKTVISIB', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: 'ロケット表示',                            en: 'Rocket visible' },
  { kw: 'MAXNBOMB', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大爆弾数（廃止）',                      en: 'Max bomb count (deprecated)' },
  // --- 99 ---
  { kw: 'ARRESTER', args: 3, type: 'vec3',   unit: 'm',    cat: 'gear',    ja: '着艦フック位置',                          en: 'Arresting hook position' },
  // --- 100 ---
  { kw: 'TRSTVCTR', args: 1, type: 'bool',   unit: '',     cat: 'engine',  ja: '推力偏向あり',                            en: 'Has thrust vectoring' },
  { kw: 'TRSTDIR0', args: -1, type: 'other', unit: '',     cat: 'engine',  ja: '推力偏向方向0',                           en: 'Thrust vector direction 0' },
  { kw: 'TRSTDIR1', args: -1, type: 'other', unit: '',     cat: 'engine',  ja: '推力偏向方向1',                           en: 'Thrust vector direction 1' },
  { kw: 'PSTMPTCH', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ポストストール仮想ピッチ速度',            en: 'Post-stall virtual pitch speed' },
  { kw: 'PSTMYAW_', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ポストストール仮想ヨー速度',              en: 'Post-stall virtual yaw speed' },
  { kw: 'PSTMROLL', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ポストストール仮想ロール速度',            en: 'Post-stall virtual roll speed' },
  // --- 106 ---
  { kw: 'AIRCLASS', args: 1, type: 'string', unit: '',     cat: 'id',      ja: '機体クラス',                              en: 'Aircraft class' },
  // --- 107 ---
  { kw: 'PROPEFCY', args: 1, type: 'scalar', unit: '',     cat: 'engine',  ja: 'プロペラ効率',                            en: 'Propeller efficiency' },
  { kw: 'PROPVMIN', args: 1, type: 'speed',  unit: 'm/s',  cat: 'engine',  ja: 'プロペラ T=P/v 有効最低速度',            en: 'Min speed for propeller T=P/v formula' },
  // --- 109 ---
  { kw: 'VRGMNOSE', args: 1, type: 'bool',   unit: '',     cat: 'aero',    ja: '可変形状ノーズあり（コンコルド）',        en: 'Variable geometry nose (Concorde)' },
  // --- 110 ---
  { kw: 'THRSTREV', args: 1, type: 'scalar', unit: '',     cat: 'engine',  ja: '逆噴射効率',                              en: 'Thrust reverser effectiveness' },
  // --- 111 ---
  { kw: 'GUNSIGHT', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: '先取り照準あり',                          en: 'Lead gun sight enabled' },
  // --- 112 ---
  { kw: 'HRDPOINT', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'ハードポイント定義',                      en: 'Hardpoint definition' },
  { kw: 'LOADWEPN', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: 'ウェポンロード',                          en: 'Load weapons' },
  { kw: 'LMTBYHDP', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: 'ハードポイントによる制限',                en: 'Limit weapons by hardpoint' },
  { kw: 'UNLOADWP', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全ウェポンアンロード',                    en: 'Unload all weapons' },
  // --- 116 ---
  { kw: 'INSTPANL', args: 1, type: 'string', unit: '',     cat: 'cockpit', ja: '計器パネル定義ファイル',                  en: 'Instrument panel definition file' },
  // --- 117 ---
  { kw: 'MACHNGN3', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃3マウント位置',                       en: 'Machine gun 3 position' },
  { kw: 'MACHNGN4', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃4マウント位置',                       en: 'Machine gun 4 position' },
  { kw: 'MACHNGN5', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃5マウント位置',                       en: 'Machine gun 5 position' },
  { kw: 'MACHNGN6', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃6マウント位置',                       en: 'Machine gun 6 position' },
  { kw: 'MACHNGN7', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃7マウント位置',                       en: 'Machine gun 7 position' },
  { kw: 'MACHNGN8', args: 3, type: 'vec3',   unit: 'm',    cat: 'weapon',  ja: '機銃8マウント位置',                       en: 'Machine gun 8 position' },
  // --- 123 ---
  { kw: 'BOMINBAY', args: 1, type: 'bool',   unit: '',     cat: 'weapon',  ja: '爆弾ベイあり',                            en: 'Has internal bomb bay' },
  { kw: 'BMBAYRCS', args: 1, type: 'scalar', unit: '',     cat: 'weapon',  ja: '爆弾ベイRCS増加量',                       en: 'Bomb bay RCS increase' },
  // --- 125 ---
  { kw: 'INITAAMM', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期中距離AAM数',                         en: 'Initial medium-range AAM count' },
  { kw: 'MAXNAAMM', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大中距離AAM数',                         en: 'Max medium-range AAM count' },
  { kw: 'INITB250', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '初期250lb爆弾数',                         en: 'Initial 250lb bomb count' },
  { kw: 'MAXNB250', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '最大250lb爆弾数',                         en: 'Max 250lb bomb count' },
  // --- 129 ---
  { kw: 'GUNINTVL', args: 1, type: 'scalar', unit: 's',    cat: 'weapon',  ja: '機銃発射間隔',                            en: 'Gun fire interval' },
  // --- 130 ---
  { kw: 'NMTURRET', args: 1, type: 'int',    unit: '',     cat: 'turret',  ja: '砲塔数',                                  en: 'Number of turrets' },
  { kw: 'TURRETPO', args: 6, type: 'other',  unit: 'm',    cat: 'turret',  ja: '砲塔位置（番号 x y z h p b）',           en: 'Turret position (id x y z h p b)' },
  { kw: 'TURRETPT', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔ピッチ範囲',                          en: 'Turret pitch range' },
  { kw: 'TURRETHD', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔旋回範囲',                            en: 'Turret heading range' },
  { kw: 'TURRETAM', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔弾薬',                                en: 'Turret ammunition' },
  { kw: 'TURRETIV', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔発射間隔',                            en: 'Turret shooting interval' },
  { kw: 'TURRETNM', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔DNMノード名',                         en: 'Turret DNM node name' },
  { kw: 'TURRETAR', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔対空能力',                            en: 'Turret anti-air capable' },
  { kw: 'TURRETGD', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔対地能力',                            en: 'Turret anti-ground capable' },
  { kw: 'TURRETCT', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔制御者（PILOT/GUNNER）',             en: 'Turret controller (PILOT/GUNNER)' },
  { kw: 'TURRETRG', args: -1, type: 'other', unit: 'm',    cat: 'turret',  ja: '砲塔射程',                                en: 'Turret range' },
  { kw: 'TURRETNH', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔旋回DNMノード名',                     en: 'Turret heading rotation node' },
  { kw: 'TURRETNP', args: -1, type: 'other', unit: '',     cat: 'turret',  ja: '砲塔俯仰DNMノード名',                     en: 'Turret pitch rotation node' },
  // --- 143 ---
  { kw: 'SETCNTRL', args: -1, type: 'other', unit: '',     cat: 'control', ja: '制御設定（ILS/TRIMなど）',                en: 'Set control (ILS, TRIM, etc.)' },
  // --- 144 ---
  { kw: 'EXCAMERA', args: -1, type: 'other', unit: '',     cat: 'cockpit', ja: '外部カメラ設定',                          en: 'Extra camera configuration' },
  // --- 145 ---
  { kw: 'NMACHNGN', args: 1, type: 'int',    unit: '',     cat: 'weapon',  ja: '機銃の総数',                              en: 'Total number of machine guns' },
  // --- 146 ---
  { kw: 'SMOKECOL', args: -1, type: 'other', unit: '',     cat: 'smoke',   ja: 'スモーク色（ALL または面名 R G B）',      en: 'Smoke color (ALL or surface R G B)' },
  // --- 147 ---
  { kw: 'SUBSTNAM', args: 1, type: 'string', unit: '',     cat: 'id',      ja: '代替機体IDENTIFY',                        en: 'Substitute aircraft IDENTIFY' },
  // --- 148 ---
  { kw: 'ISPNLPOS', args: -1, type: 'other', unit: '',     cat: 'cockpit', ja: '計器パネル位置',                          en: 'Instrument panel position' },
  { kw: 'ISPNLSCL', args: 1, type: 'scalar', unit: '',     cat: 'cockpit', ja: '計器パネルスケール',                      en: 'Instrument panel scale' },
  // --- 150 ---
  { kw: 'ISPNLHUD', args: 1, type: 'bool',   unit: '',     cat: 'cockpit', ja: '計器パネルとHUD同時表示',                 en: 'Show both inst panel and HUD' },
  { kw: 'COCKPITA', args: -1, type: 'other', unit: '',     cat: 'cockpit', ja: 'コックピット中立頭部方向',                en: 'Cockpit neutral head direction' },
  { kw: 'SCRNCNTR', args: -1, type: 'other', unit: '',     cat: 'cockpit', ja: 'スクリーン中心座標',                      en: 'Screen center (relative -1..1)' },
  { kw: 'ISPNLATT', args: -1, type: 'other', unit: '',     cat: 'cockpit', ja: '計器パネル向き',                          en: 'Instrument panel orientation' },
  // --- 154 ---
  { kw: 'MAXNMFLR', args: 1, type: 'int',    unit: '',     cat: 'smoke',   ja: '最大フレア数',                            en: 'Max flare count' },
  // --- 155 ---
  { kw: 'FLAPPOSI', args: -1, type: 'other', unit: '',     cat: 'smoke',   ja: 'フラップ位置',                            en: 'Flap position' },
  { kw: 'FLAREPOS', args: -1, type: 'other', unit: '',     cat: 'smoke',   ja: 'フレア射出位置と方向',                    en: 'Flare dispenser position and direction' },
  // --- 157 ---
  { kw: 'INITAAAM', args: 1, type: 'int',    unit: '',     cat: 'smoke',   ja: '初期AIM-9X数',                            en: 'Initial AIM-9X count' },
  { kw: 'INITHDBM', args: 1, type: 'int',    unit: '',     cat: 'smoke',   ja: '初期高抵抗爆弾数',                        en: 'Initial high-drag bomb count' },
  // --- 159 ---
  { kw: 'ULOADAAM', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全AAMアンロード',                         en: 'Unload all AAMs' },
  { kw: 'ULOADAGM', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全AGMアンロード',                         en: 'Unload all AGMs' },
  { kw: 'ULOADBOM', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全爆弾アンロード',                        en: 'Unload all bombs' },
  { kw: 'ULOADFLR', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全フレアアンロード',                      en: 'Unload all flares' },
  { kw: 'ULOADGUN', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全機銃弾アンロード',                      en: 'Unload all gun ammo' },
  { kw: 'ULOADRKT', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全ロケットアンロード',                    en: 'Unload all rockets' },
  // --- 165 ---
  { kw: 'LOOKOFST', args: 3, type: 'vec3',   unit: 'm',    cat: 'cockpit', ja: 'ルックアットオフセット',                  en: 'Look-at offset' },
  // --- 166 ---
  { kw: 'WPNSHAPE', args: -1, type: 'other', unit: '',     cat: 'cockpit', ja: 'ウェポン形状オーバーライド',              en: 'Weapon shape override' },
  // --- 167 ---
  { kw: 'GEARHORN', args: 1, type: 'bool',   unit: '',     cat: 'gear',    ja: 'ギア警告音あり',                          en: 'Landing-gear warning horn' },
  { kw: 'STALHORN', args: 1, type: 'bool',   unit: '',     cat: 'gear',    ja: '失速警告音あり',                          en: 'Stall-warning horn' },
  // --- 169 ---
  { kw: 'CKPITIST', args: 1, type: 'bool',   unit: '',     cat: 'cockpit', ja: 'デフォルト視点で計器パネルを隠す',        en: 'Hide inst panel in default cockpit view' },
  { kw: 'CKPITHUD', args: 1, type: 'bool',   unit: '',     cat: 'cockpit', ja: 'デフォルト視点でHUDを隠す',               en: 'Hide HUD in default cockpit view' },
  // --- 171 ---
  { kw: 'MALFUNCT', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: '機能不全設定',                            en: 'Malfunction configuration' },
  { kw: 'REPAIRAL', args: 0, type: 'other',  unit: '',     cat: 'weapon',  ja: '全修理',                                  en: 'Repair all' },
  { kw: 'REPAIRFN', args: -1, type: 'other', unit: '',     cat: 'weapon',  ja: '部分修理設定',                            en: 'Repair functionality' },
  // --- 174 ---
  { kw: 'NOLDGFLR', args: 1, type: 'bool',   unit: '',     cat: 'gear',    ja: '着陸フレアなし',                          en: 'No landing flare' },
  // --- 175 ---
  { kw: 'NREALPRP', args: 1, type: 'int',    unit: '',     cat: 'engine',  ja: 'リアルプロペラエンジン数',                en: 'Number of realistic propeller engines' },
  { kw: 'REALPROP', args: -1, type: 'other', unit: '',     cat: 'engine',  ja: 'リアルプロペラ設定',                      en: 'Realistic propeller engine parameters' },
  // --- 177 ---
  { kw: 'TIREFRIC', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'タイヤ摩擦係数',                          en: 'Tire friction coefficient' },
  // --- 178 ---
  { kw: 'PSTMSPD1', args: 1, type: 'speed',  unit: 'm/s',  cat: 'control', ja: 'ポストストール直接制御有効最高速度',      en: 'Max speed for full direct attitude control' },
  { kw: 'PSTMSPD2', args: 1, type: 'speed',  unit: 'm/s',  cat: 'control', ja: 'ポストストール直接制御無効速度',          en: 'Speed at which direct attitude control fails' },
  { kw: 'PSTMPWR1', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ポストストール最低パワー設定',            en: 'Min power for direct attitude control' },
  { kw: 'PSTMPWR2', args: 1, type: 'scalar', unit: '',     cat: 'control', ja: 'ポストストール完全有効パワー設定',        en: 'Power for full direct attitude control' },
  // --- 182 ---
  { kw: 'MAXCDAOA', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: '最大CDにおける迎角',                      en: 'AOA at maximum CD' },
  { kw: 'FLATCLR1', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'フラット揚力範囲1',                       en: 'Flat CL region 1' },
  { kw: 'FLATCLR2', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'フラット揚力範囲2',                       en: 'Flat CL region 2' },
  { kw: 'CLDECAY1', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'CL減衰定数1',                             en: 'CL decay constant 1' },
  { kw: 'CLDECAY2', args: 1, type: 'scalar', unit: '',     cat: 'aero',    ja: 'CL減衰定数2',                             en: 'CL decay constant 2' },
  // --- 187 ---
  { kw: 'AIRSTATE', args: 0, type: 'other',  unit: '',     cat: 'init',    ja: '機体状態設定（複合コマンド）',            en: 'Aircraft state configuration (compound)' },
  // --- 188 ---
  { kw: 'INITZOOM', args: 1, type: 'scalar', unit: '',     cat: 'cockpit', ja: '初期ズーム倍率',                          en: 'Initial zoom factor' },
];

// Fast lookup map by keyword string.
export const SCHEMA_BY_KW = new Map(DAT_SCHEMA.map((k) => [k.kw, k]));

// All categories in display order.
export const DAT_CATEGORIES = [
  'id', 'engine', 'weight', 'aero', 'control', 'gear', 'weapon',
  'turret', 'smoke', 'cockpit', 'init', 'perf', 'meta',
];
