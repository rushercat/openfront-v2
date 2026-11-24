// Historical scenarios (openfront v2): a stock map with nations at their
// historical positions, starting borders and fixed alliances. The engine sets
// them up (HistoricalScenarioExecution); the lobby and the HUD read the same
// data. Coordinates are tiles of the scenario map at normal size.

import {
  GameMapSize,
  GameMapType,
  HistoricalScenarioId,
} from "@openfront/engine-api/game/GameTypes";
import type {
  MissionDef,
  MissionGoal,
  MissionSpec,
} from "@openfront/engine-api/game/Missions";
import type { GameConfig } from "@openfront/engine-api/Schemas";

/**
 * Where a nation's starting land grows from. Every seed claims land outward
 * at the same speed, first come first served (so borders fall halfway
 * between neighbours), up to `radius` steps from the seed.
 */
export interface ScenarioSeed {
  x: number;
  y: number;
  radius: number;
}

export interface ScenarioNation {
  /** Stable id: what hosts assign players to. */
  key: string;
  name: string;
  /** Flag file (resources/flags). Unique within a scenario: it also tells
   *  which scenario nation a player is. */
  flag: string;
  /** The bloc whose members start allied and stay allied, or null. */
  bloc: string | null;
  /** Great powers get human players first when the host assigns no one. */
  major: boolean;
  seeds: ScenarioSeed[];
}

export interface ScenarioBloc {
  key: string;
  /** en.json key of the bloc's name. */
  nameKey: string;
}

export interface HistoricalScenario {
  id: HistoricalScenarioId;
  map: GameMapType;
  /** en.json keys. */
  nameKey: string;
  descriptionKey: string;
  blocs: ScenarioBloc[];
  nations: ScenarioNation[];
  /**
   * How many open-sea tiles a nation's land may hop across while it grows
   * (straits, island chains). Lakes and rivers never stop it.
   */
  oceanHop: number;
  /** Share of its troop cap every scenario nation starts with. */
  startingTroopShare: number;
  /**
   * Secret missions (GameConfig.scenarioMissions) by nation key: a player
   * of that nation gets one of them at random. Nations without any get a
   * generic one (see genericMissions).
   */
  missions?: Record<string, MissionSpec[]>;
}

// Mission building blocks.
const conquer = (...nations: string[]): MissionGoal => ({
  kind: "conquer",
  nations,
});
const eliminate = (nation: string): MissionGoal => ({
  kind: "eliminate",
  nation,
});
const land = (share: number): MissionGoal => ({ kind: "land", share });
const cities = (levels: number): MissionGoal => ({ kind: "cities", levels });
/**
 * A historical mission: what the nation really did or aimed for. Its
 * background text is en.json `missions.note.<scenario id>.<nation key>`,
 * so a nation has at most one.
 */
const hist = (...goals: MissionGoal[]): MissionSpec => ({
  historical: true,
  goals,
});

/** No cap: the seed grows until it meets its neighbours. */
const FAR = 5000;

const seed = (x: number, y: number, radius = FAR): ScenarioSeed => ({
  x,
  y,
  radius,
});

const EUROPE_1939: HistoricalScenario = {
  id: HistoricalScenarioId.Europe1939,
  map: GameMapType.Europe,
  nameKey: "historical_scenario.europe1939.name",
  descriptionKey: "historical_scenario.europe1939.description",
  oceanHop: 12,
  startingTroopShare: 0.35,
  blocs: [
    { key: "axis", nameKey: "historical_scenario.bloc.axis" },
    { key: "allies", nameKey: "historical_scenario.bloc.allies" },
    { key: "comintern", nameKey: "historical_scenario.bloc.comintern" },
  ],
  nations: [
    // The Axis, September 1939: the Reich with Austria and Bohemia, Italy
    // with Albania and Libya, and Slovakia.
    {
      key: "germany",
      name: "German Reich",
      flag: "de",
      bloc: "axis",
      major: true,
      seeds: [seed(1445, 821), seed(1507, 959), seed(1618, 874)],
    },
    {
      key: "italy",
      name: "Kingdom of Italy",
      flag: "italy",
      bloc: "axis",
      major: true,
      seeds: [
        seed(1541, 1180),
        seed(1817, 1213, 60),
        seed(1847, 1652, 220),
        seed(1580, 1369),
        seed(1371, 1267),
      ],
    },
    {
      key: "slovakia",
      name: "Slovakia",
      flag: "sk",
      bloc: "axis",
      major: false,
      seeds: [seed(1826, 902, 100)],
    },
    // The Allies: Britain with Egypt, Palestine, Transjordan and Cyprus;
    // France with North Africa, Syria, Lebanon and Corsica; Poland.
    {
      key: "uk",
      name: "United Kingdom",
      flag: "gb",
      bloc: "allies",
      major: true,
      seeds: [
        seed(962, 780),
        seed(863, 775),
        seed(841, 603),
        seed(719, 685),
        seed(2226, 1661, 230),
        seed(2406, 1638, 90),
        seed(2535, 1609, 150),
        seed(2355, 1472),
      ],
    },
    {
      key: "france",
      name: "France",
      flag: "fr",
      bloc: "allies",
      major: true,
      seeds: [
        seed(1087, 983),
        seed(1066, 1506, 330),
        seed(1359, 1473, 150),
        seed(769, 1535, 260),
        seed(2538, 1418, 150),
        seed(2473, 1528, 60),
        seed(1374, 1183),
      ],
    },
    {
      key: "poland",
      name: "Poland",
      flag: "pl",
      bloc: "allies",
      major: true,
      seeds: [seed(1751, 772)],
    },
    // The Soviet Union, bound to no one by the pact of August 1939.
    {
      key: "ussr",
      name: "Soviet Union",
      flag: "ussr",
      bloc: "comintern",
      major: true,
      seeds: [
        seed(2591, 610),
        seed(2206, 676),
        seed(2231, 885),
        seed(2748, 1138),
        seed(2890, 857),
        seed(2322, 150),
        seed(2376, 433),
      ],
    },
    // Neutrals: free to make (and break) alliances of their own.
    {
      key: "spain",
      name: "Spain",
      flag: "es",
      bloc: null,
      major: true,
      seeds: [seed(874, 1286), seed(1125, 1286)],
    },
    {
      key: "turkey",
      name: "Turkey",
      flag: "tr",
      bloc: null,
      major: true,
      seeds: [seed(2334, 1313)],
    },
    {
      key: "sweden",
      name: "Sweden",
      flag: "se",
      bloc: null,
      major: false,
      seeds: [seed(1609, 477), seed(1795, 215)],
    },
    {
      key: "romania",
      name: "Romania",
      flag: "ro",
      bloc: null,
      major: false,
      seeds: [seed(2046, 990)],
    },
    {
      key: "yugoslavia",
      name: "Yugoslavia",
      flag: "yugoslavia",
      bloc: null,
      major: false,
      seeds: [seed(1906, 1113), seed(1624, 1038), seed(1738, 1107)],
    },
    {
      key: "finland",
      name: "Finland",
      flag: "fi",
      bloc: null,
      major: false,
      seeds: [seed(2032, 346, 260)],
    },
    {
      key: "norway",
      name: "Norway",
      flag: "no",
      bloc: null,
      major: false,
      seeds: [seed(1360, 428), seed(1744, 123)],
    },
    {
      key: "hungary",
      name: "Hungary",
      flag: "Kingdom of Hungary",
      bloc: null,
      major: false,
      seeds: [seed(1751, 983, 160)],
    },
    {
      key: "portugal",
      name: "Portugal",
      flag: "pt",
      bloc: null,
      major: false,
      seeds: [seed(680, 1254, 150)],
    },
    {
      key: "netherlands",
      name: "Netherlands",
      flag: "nl",
      bloc: null,
      major: false,
      seeds: [seed(1268, 764, 100)],
    },
    {
      key: "belgium",
      name: "Belgium",
      flag: "be",
      bloc: null,
      major: false,
      seeds: [seed(1182, 836, 90)],
    },
    {
      key: "switzerland",
      name: "Switzerland",
      flag: "ch",
      bloc: null,
      major: false,
      seeds: [seed(1339, 997, 70)],
    },
    {
      key: "denmark",
      name: "Denmark",
      flag: "dk",
      bloc: null,
      major: false,
      seeds: [seed(1377, 625, 130), seed(266, 265)],
    },
    {
      key: "ireland",
      name: "Ireland",
      flag: "ie",
      bloc: null,
      major: false,
      seeds: [seed(634, 781)],
    },
    {
      key: "estonia",
      name: "Estonia",
      flag: "ee",
      bloc: null,
      major: false,
      seeds: [seed(2052, 516, 110)],
    },
    {
      key: "latvia",
      name: "Latvia",
      flag: "lv",
      bloc: null,
      major: false,
      seeds: [seed(2030, 617, 110)],
    },
    {
      key: "lithuania",
      name: "Lithuania",
      flag: "lt",
      bloc: null,
      major: false,
      seeds: [seed(1958, 704, 110)],
    },
    {
      key: "bulgaria",
      name: "Bulgaria",
      flag: "bg",
      bloc: null,
      major: false,
      seeds: [seed(2092, 1158, 160)],
    },
    {
      key: "greece",
      name: "Greece",
      flag: "gr",
      bloc: null,
      major: false,
      seeds: [
        seed(1891, 1299, 220),
        seed(2014, 1464, 220),
        seed(1971, 1329, 220),
      ],
    },
    {
      key: "iraq",
      name: "Kingdom of Iraq",
      flag: "Kingdom of Iraq",
      bloc: null,
      major: false,
      seeds: [seed(2689, 1441, 250)],
    },
  ],
  missions: {
    germany: [
      hist(conquer("poland", "france", "norway", "netherlands")),
      [eliminate("ussr")],
      [conquer("france", "poland", "uk")],
      [land(0.3)],
    ],
    italy: [
      hist(conquer("greece", "yugoslavia")),
      [eliminate("france")],
      [land(0.18), cities(20)],
      [conquer("spain", "turkey")],
    ],
    uk: [hist(eliminate("germany")), [conquer("italy", "spain")], [land(0.2)]],
    france: [
      hist(conquer("germany")),
      [conquer("italy", "spain")],
      [land(0.2)],
    ],
    poland: [
      hist(conquer("germany")),
      [conquer("lithuania", "latvia", "estonia")],
      [land(0.15)],
      [eliminate("ussr")],
    ],
    ussr: [
      hist(eliminate("germany")),
      [conquer("poland", "finland", "romania")],
      [land(0.3)],
    ],
    spain: [
      hist(cities(15)),
      [conquer("portugal", "france")],
      [eliminate("uk")],
      [land(0.18)],
    ],
    turkey: [
      hist(cities(12)),
      [conquer("greece", "bulgaria", "iraq")],
      [eliminate("ussr")],
      [land(0.18)],
    ],
    hungary: [hist(conquer("romania"))],
    bulgaria: [hist(conquer("greece"))],
  },
};

/** Shorthand for a nation entry. */
const nation = (
  key: string,
  name: string,
  flag: string,
  major: boolean,
  seeds: ScenarioSeed[],
  bloc: string | null = null,
): ScenarioNation => ({ key, name, flag, bloc, major, seeds });

// ── Mare Nostrum, 218 BC ──────────────────────────────────────────────────
// Hannibal crosses the Alps: Rome and Carthage go to war again, while the
// heirs of Alexander watch from the east and the Celts from the north.
const MARE_NOSTRUM_218: HistoricalScenario = {
  id: HistoricalScenarioId.MareNostrum218,
  map: GameMapType.MareNostrum,
  nameKey: "historical_scenario.marenostrum218.name",
  descriptionKey: "historical_scenario.marenostrum218.description",
  oceanHop: 12,
  startingTroopShare: 0.35,
  blocs: [],
  nations: [
    nation("rome", "Roman Republic", "SPQR", true, [
      seed(1307, 479),
      seed(1450, 620),
      seed(1350, 762, 90),
      seed(1058, 534, 90),
    ]),
    nation("carthage", "Carthage", "Carthage", true, [
      seed(1091, 989),
      seed(353, 787),
      seed(450, 700, 200),
    ]),
    nation("macedon", "Macedon", "Macedonia", true, [
      seed(1811, 402),
      seed(2030, 457, 120),
    ]),
    nation("seleucids", "Seleucid Empire", "Achaemenid Empire", true, [
      seed(2584, 990),
      seed(2772, 845),
      seed(2447, 809, 120),
      seed(2516, 648, 120),
    ]),
    nation("ptolemies", "Ptolemaic Egypt", "Khemet", true, [
      seed(2263, 1240),
      seed(1799, 1096, 200),
      seed(2379, 942, 60),
      seed(2490, 1141, 120),
    ]),
    nation("gauls", "Celtic Tribes", "Celtic Tribes", true, [
      seed(699, 340),
      seed(596, 91),
      seed(910, 218),
      seed(1150, 250),
    ]),
    nation("numidia", "Numidia", "Amazigh flag", false, [seed(584, 1199)]),
    nation("mauretania", "Mauretania", "mr", false, [seed(264, 1028)]),
    nation("iberians", "Celtiberians", "castille", false, [
      seed(141, 574),
      seed(464, 519),
    ]),
    nation("illyrians", "Illyrians", "al", false, [seed(1522, 301)]),
    nation("dacians", "Dacians", "ro", false, [seed(1910, 119)]),
    nation("epirus", "Epirus", "gr", false, [seed(1654, 560, 120)]),
    nation("achaea", "Achaean League", "Athens", false, [seed(1774, 774, 150)]),
    nation("syracuse", "Syracuse", "Sicily", false, [seed(1401, 809, 45)]),
    nation("rhodes", "Rhodes", "Kingdom Of Cyprus", false, [
      seed(2196, 828, 70),
    ]),
    nation("pergamon", "Pergamon", "Byzantine Empire", false, [
      seed(2065, 690, 180),
    ]),
    nation("pontus", "Pontus", "Armenian Kingdom Of Cilicia", false, [
      seed(2354, 505),
    ]),
    nation("galatians", "Galatians", "Kingdom of Ireland", false, [
      seed(2325, 669, 120),
    ]),
    nation("bosporus", "Bosporan Kingdom", "ua", false, [seed(2428, 200)]),
    nation("thracians", "Thracians", "bg", false, [seed(2114, 250)]),
    nation("parthia", "Parthia", "Sassanid Empire", false, [seed(2815, 659)]),
    nation("nabataeans", "Nabataeans", "Saba kingdom", false, [
      seed(2481, 1292),
    ]),
  ],
  missions: {
    rome: [
      hist(eliminate("carthage")),
      [conquer("carthage", "ptolemies")],
      [land(0.28)],
    ],
    carthage: [
      hist(conquer("iberians"), land(0.15)),
      [eliminate("rome")],
      [conquer("rome", "gauls")],
      [land(0.22), cities(15)],
    ],
    macedon: [
      hist(conquer("illyrians", "epirus")),
      [conquer("seleucids", "ptolemies")],
      [conquer("achaea", "pergamon", "rhodes")],
      [eliminate("rome")],
    ],
    seleucids: [
      hist(conquer("parthia"), land(0.2)),
      [conquer("macedon", "pergamon")],
      [land(0.25)],
      [eliminate("rome")],
    ],
    ptolemies: [
      hist(conquer("nabataeans"), cities(20)),
      [eliminate("seleucids")],
      [conquer("rhodes", "carthage")],
      [eliminate("macedon")],
    ],
    gauls: [
      hist(conquer("rome")),
      [conquer("iberians", "illyrians")],
      [land(0.25)],
      [eliminate("macedon")],
    ],
    numidia: [hist(conquer("carthage"))],
    parthia: [hist(conquer("seleucids"))],
    pontus: [hist(conquer("pergamon", "bosporus"))],
  },
};

// ── Sengoku Jidai, 1560 ───────────────────────────────────────────────────
// The age of warring states: the shogun in Kyoto has lost his power, and the
// great clans fight to unite Japan under their banner.
const SENGOKU_1560: HistoricalScenario = {
  id: HistoricalScenarioId.Sengoku1560,
  map: GameMapType.Japan,
  nameKey: "historical_scenario.sengoku1560.name",
  descriptionKey: "historical_scenario.sengoku1560.description",
  oceanHop: 10,
  startingTroopShare: 0.4,
  blocs: [],
  nations: [
    nation("oda", "Oda Clan", "Clan Oda", true, [seed(1300, 1300)]),
    nation("takeda", "Takeda Clan", "Clan Takeda", true, [seed(1420, 1180)]),
    nation("uesugi", "Uesugi Clan", "Clan Uesugi", true, [seed(1440, 1050)]),
    nation("hojo", "Hojo Clan", "Clan Hojo", true, [seed(1560, 1170)]),
    nation("mori", "Mori Clan", "Clan Mori", true, [seed(860, 1320)]),
    nation("shimazu", "Shimazu Clan", "Clan Shimazu", true, [seed(675, 1680)]),
    nation("date", "Date Clan", "Clan Date", false, [seed(1647, 897)]),
    nation("imagawa", "Imagawa Clan", "Clan Imagawa", false, [
      seed(1470, 1270),
    ]),
    nation("asakura", "Asakura Clan", "Clan Asakura", false, [
      seed(1230, 1215),
    ]),
    nation("miyoshi", "Miyoshi Clan", "Clan Miyoshi", false, [
      seed(1191, 1370),
    ]),
    nation("ashikaga", "Ashikaga Shogunate", "Ashikaga Shogunate", false, [
      seed(1158, 1290, 45),
    ]),
    nation("otomo", "Otomo Clan", "Clan Otomo", false, [seed(730, 1530)]),
    nation("chosokabe", "Chosokabe Clan", "Clan Chosokabe", false, [
      seed(949, 1454),
    ]),
    nation("amago", "Amago Clan", "Clan Amago", false, [seed(1000, 1250)]),
    nation("nanbu", "Nanbu Clan", "Clan Nanbu", false, [seed(1700, 650)]),
    nation("ainu", "Ainu", "Ainu", false, [seed(1895, 288)]),
    nation("ryukyu", "Ryukyu Kingdom", "Ryukyu Kingdom", false, [
      seed(397, 2283),
    ]),
  ],
  missions: {
    oda: [
      hist(conquer("imagawa", "ashikaga")),
      [conquer("miyoshi", "asakura")],
      [eliminate("takeda")],
      [land(0.3)],
    ],
    takeda: [
      hist(conquer("imagawa"), land(0.15)),
      [conquer("ashikaga", "oda")],
      [eliminate("uesugi")],
      [conquer("hojo", "date")],
    ],
    uesugi: [
      hist(conquer("hojo")),
      [eliminate("takeda")],
      [conquer("date", "nanbu", "asakura")],
      [land(0.25)],
    ],
    hojo: [
      hist(land(0.15), cities(15)),
      [conquer("imagawa", "takeda")],
      [eliminate("uesugi")],
      [land(0.25)],
    ],
    mori: [
      hist(eliminate("amago")),
      [conquer("otomo", "chosokabe")],
      [conquer("ashikaga", "miyoshi")],
      [eliminate("oda")],
    ],
    shimazu: [
      hist(conquer("otomo", "ryukyu")),
      [eliminate("mori")],
      [land(0.25)],
      [conquer("chosokabe", "miyoshi")],
    ],
    chosokabe: [hist(conquer("miyoshi"))],
  },
};

// ── The Italian Wars, 1494 ────────────────────────────────────────────────
// Charles VIII of France marches on Naples; the city-states of the
// Renaissance scheme, trade and fight for the peninsula.
const ITALY_1494: HistoricalScenario = {
  id: HistoricalScenarioId.Italy1494,
  map: GameMapType.Italia,
  nameKey: "historical_scenario.italy1494.name",
  descriptionKey: "historical_scenario.italy1494.description",
  oceanHop: 12,
  startingTroopShare: 0.35,
  blocs: [],
  nations: [
    nation("venice", "Republic of Venice", "venice", true, [
      seed(595, 190),
      seed(980, 340, 100),
    ]),
    nation("milan", "Duchy of Milan", "Duchy of Milan", true, [seed(320, 176)]),
    nation("florence", "Republic of Florence", "Grand Duchy of Tuscany", true, [
      seed(568, 400),
    ]),
    nation("papal", "Papal States", "PapalStates", true, [
      seed(640, 560),
      seed(680, 350, 90),
    ]),
    nation("naples", "Kingdom of Naples", "TwoSicilies", true, [
      seed(815, 707),
      seed(1038, 993),
    ]),
    nation("france", "Kingdom of France", "Kingdom of France", true, [
      seed(29, 266),
      seed(40, 150),
    ]),
    nation("habsburg", "Holy Roman Empire", "Holy Roman Empire", false, [
      seed(747, 39),
      seed(950, 60),
    ]),
    nation("ottoman", "Ottoman Empire", "Ottoman Empire", false, [
      seed(1238, 349),
    ]),
    nation("aragon", "Crown of Aragon", "Crown Of Aragon", false, [
      seed(896, 1072),
      seed(278, 774),
    ]),
    nation("savoy", "Duchy of Savoy", "Kingdom of Sardinia", false, [
      seed(120, 290),
    ]),
    nation("genoa", "Republic of Genoa", "gb-eng", false, [seed(376, 328, 60)]),
    nation("ferrara", "Duchy of Ferrara", "Duchy of Modena and Reggio", false, [
      seed(469, 330, 60),
    ]),
    nation("mantua", "Marquisate of Mantua", "Duchy of Parma", false, [
      seed(440, 240, 45),
    ]),
    nation("siena", "Republic of Siena", "sm", false, [seed(560, 480, 50)]),
    nation("swiss", "Old Swiss Confederacy", "ch", false, [seed(361, 68)]),
    nation("hungary", "Kingdom of Hungary", "Kingdom of Hungary", false, [
      seed(1255, 31),
    ]),
    nation("tunis", "Hafsid Tunis", "tn", false, [seed(370, 1137)]),
    nation("hospitallers", "Knights Hospitaller", "Order Of Malta", false, [
      seed(870, 1240, 30),
    ]),
  ],
  missions: {
    venice: [
      hist(conquer("ferrara", "mantua")),
      [conquer("milan", "genoa")],
      [conquer("naples", "hospitallers")],
      [eliminate("milan")],
    ],
    milan: [
      hist(conquer("genoa"), cities(15)),
      [conquer("venice", "ferrara")],
      [eliminate("florence")],
      [land(0.25)],
    ],
    florence: [
      hist(conquer("siena"), cities(20)),
      [eliminate("venice")],
      [conquer("papal", "genoa")],
    ],
    papal: [
      hist(conquer("ferrara"), land(0.12)),
      [eliminate("france")],
      [conquer("florence", "naples")],
      [land(0.25)],
    ],
    naples: [
      hist(eliminate("france")),
      [conquer("aragon", "papal")],
      [land(0.25)],
      [conquer("venice")],
    ],
    france: [
      hist(conquer("milan", "naples")),
      [eliminate("papal")],
      [land(0.3)],
      [conquer("venice", "florence")],
    ],
    habsburg: [hist(conquer("papal"))],
    aragon: [hist(conquer("naples"))],
    swiss: [hist(conquer("milan"))],
    ottoman: [hist(conquer("hungary"))],
  },
};

// ── Britannia, 800 ────────────────────────────────────────────────────────
// The isles before the Vikings: seven Saxon kingdoms, the Britons of Wales,
// Picts and Scots in the north and the Irish kings across the sea.
const BRITANNIA_800: HistoricalScenario = {
  id: HistoricalScenarioId.Britannia800,
  map: GameMapType.Britannia,
  nameKey: "historical_scenario.britannia800.name",
  descriptionKey: "historical_scenario.britannia800.description",
  oceanHop: 8,
  startingTroopShare: 0.35,
  blocs: [],
  nations: [
    nation("wessex", "Wessex", "1_Wessex", true, [
      seed(1148, 1820),
      seed(1000, 1830),
    ]),
    nation("mercia", "Mercia", "1_Mercia", true, [seed(1100, 1580)]),
    nation("northumbria", "Northumbria", "1_Northumbria", true, [
      seed(1118, 1202),
      seed(1051, 946),
    ]),
    nation("fortriu", "Picts of Fortriu", "1_Fortriu", true, [
      seed(856, 672),
      seed(971, 517),
      seed(703, 431),
    ]),
    nation("gwynedd", "Gwynedd", "1_Gwynedd", true, [seed(850, 1500)]),
    nation("munster", "Munster", "1_Munster", true, [
      seed(189, 1605),
      seed(257, 1458),
    ]),
    nation("east_anglia", "East Anglia", "1_East Anglia", false, [
      seed(1400, 1495),
    ]),
    nation("kent", "Kent", "1_Kent", false, [seed(1380, 1880)]),
    nation("essex", "Essex", "1_Essex", false, [seed(1325, 1800)]),
    nation("sussex", "Sussex", "1_Sussex", false, [seed(1220, 1905)]),
    nation("powys", "Powys", "1_Powys", false, [seed(920, 1630)]),
    nation("dyfed", "Dyfed", "1_Dyfed", false, [seed(750, 1725)]),
    nation("gwent", "Gwent", "1_Gwent", false, [seed(920, 1735)]),
    nation("dumnonia", "Dumnonia", "1_Dumnonia", false, [seed(800, 1900)]),
    nation("strathclyde", "Strathclyde", "1_Strathclyde", false, [
      seed(740, 850),
    ]),
    nation("dalriata", "Dal Riata", "1_Dalriata", false, [seed(611, 690)]),
    nation("ulaid", "Ulaid", "1_Ulaid", false, [seed(575, 1100)]),
    nation("n_ui_neill", "Northern Ui Neill", "1_Northern Ui Neill", false, [
      seed(400, 1075),
    ]),
    nation("airgialla", "Airgialla", "1_Airgialla", false, [seed(500, 1175)]),
    nation("s_ui_neill", "Southern Ui Neill", "1_Southern Ui Neill", false, [
      seed(527, 1295),
    ]),
    nation("connacht", "Connacht", "1_Connacht", false, [seed(214, 1242)]),
    nation("laigin", "Laigin", "1_Laigin", false, [seed(525, 1400)]),
    nation("franks", "Frankish Empire", "1_Franks", false, [seed(1560, 1990)]),
  ],
  missions: {
    wessex: [
      hist(conquer("mercia", "kent", "essex")),
      [eliminate("northumbria")],
      [land(0.3)],
      [conquer("dumnonia", "gwent", "gwynedd")],
    ],
    mercia: [
      hist(conquer("kent", "east_anglia")),
      [conquer("wessex")],
      [eliminate("northumbria")],
      [conquer("gwynedd", "powys")],
    ],
    northumbria: [
      hist(conquer("strathclyde")),
      [conquer("fortriu", "dalriata")],
      [eliminate("mercia")],
      [land(0.25)],
    ],
    fortriu: [
      hist(conquer("dalriata", "strathclyde")),
      [eliminate("northumbria")],
      [land(0.2)],
      [conquer("ulaid", "n_ui_neill")],
    ],
    gwynedd: [
      hist(conquer("powys", "dyfed")),
      [eliminate("mercia")],
      [conquer("strathclyde", "dumnonia")],
      [conquer("gwent", "wessex")],
    ],
    munster: [
      hist(conquer("laigin", "connacht")),
      [eliminate("n_ui_neill")],
      [land(0.2)],
      [conquer("dyfed", "dumnonia")],
    ],
    dalriata: [hist(conquer("fortriu"))],
    n_ui_neill: [hist(conquer("airgialla", "ulaid"))],
  },
};

// ── Scramble for Africa, 1884 ─────────────────────────────────────────────
// The Berlin Conference: the colonial powers hold little more than their
// coastal footholds, and the race into the interior begins. Much of the
// continent is still unclaimed.
const AFRICA_1884: HistoricalScenario = {
  id: HistoricalScenarioId.Africa1884,
  map: GameMapType.Africa,
  nameKey: "historical_scenario.africa1884.name",
  descriptionKey: "historical_scenario.africa1884.description",
  oceanHop: 12,
  startingTroopShare: 0.4,
  blocs: [],
  nations: [
    nation("uk", "British Empire", "gb", true, [
      seed(1144, 1894, 220),
      seed(1364, 236, 220),
      seed(208, 832, 90),
      seed(650, 860, 60),
    ]),
    nation("france", "French Republic", "fr", true, [
      seed(541, 79, 260),
      seed(99, 644, 150),
      seed(786, 52, 110),
      seed(839, 1005, 110),
    ]),
    nation("germany", "German Empire", "German Empire", true, [
      seed(1012, 1659, 170),
      seed(879, 875, 110),
      seed(560, 860, 50),
      seed(1492, 1225, 120),
    ]),
    nation("portugal", "Kingdom of Portugal", "kingdom_of_portugal", true, [
      seed(1021, 1365, 190),
      seed(1551, 1516, 190),
      seed(150, 700, 60),
    ]),
    nation("belgium", "Congo Free State", "be", true, [seed(1132, 1118, 250)]),
    nation("italy", "Kingdom of Italy", "it", true, [
      seed(1604, 641, 90),
      seed(1844, 910, 160),
      seed(841, 149, 110),
    ]),
    nation("morocco", "Sultanate of Morocco", "ma", false, [
      seed(345, 139, 260),
    ]),
    nation("ethiopia", "Ethiopian Empire", "Ethiopian Empire", false, [
      seed(1582, 832, 240),
    ]),
    nation("mahdist", "Mahdist State", "Mahdist Sudan", false, [
      seed(1414, 661, 320),
    ]),
    nation("ottoman_libya", "Ottoman Tripolitania", "Ottoman Empire", false, [
      seed(1038, 243, 280),
    ]),
    nation("sokoto", "Sokoto Caliphate", "ng", false, [seed(725, 750, 260)]),
    nation("ashanti", "Ashanti Empire", "gh", false, [seed(450, 825, 110)]),
    nation("dahomey", "Kingdom of Dahomey", "Kingdom of Dahomey", false, [
      seed(604, 857, 70),
    ]),
    nation("liberia", "Liberia", "lr", false, [seed(266, 841, 110)]),
    nation("kongo", "Kingdom of Kongo", "Kingdom of Kongo", false, [
      seed(950, 1250, 100),
    ]),
    nation("buganda", "Buganda", "ug", false, [seed(1414, 1042, 130)]),
    nation("zanzibar", "Sultanate of Zanzibar", "Zanzibar", false, [
      seed(1560, 1180, 70),
    ]),
    nation("ndebele", "Matabele Kingdom", "zw", false, [seed(1340, 1611, 160)]),
    nation("transvaal", "Transvaal Republic", "Transvaal", false, [
      seed(1275, 1750, 140),
    ]),
    nation("orange", "Orange Free State", "Orange Free State", false, [
      seed(1200, 1800, 110),
    ]),
    nation("zulu", "Zulu Kingdom", "Zulu", false, [seed(1355, 1819, 90)]),
    nation("merina", "Merina Kingdom", "Merina Kingdom", false, [
      seed(1804, 1574, 320),
    ]),
  ],
  missions: {
    uk: [
      hist(conquer("mahdist", "transvaal")),
      [conquer("buganda", "sokoto")],
      [eliminate("france")],
      [land(0.25)],
    ],
    france: [
      hist(conquer("dahomey", "merina", "morocco")),
      [conquer("sokoto", "mahdist")],
      [eliminate("uk")],
      [land(0.25)],
    ],
    germany: [
      hist(conquer("zanzibar"), land(0.12)),
      [conquer("belgium", "portugal")],
      [eliminate("uk")],
      [land(0.2)],
    ],
    portugal: [
      hist(conquer("ndebele", "kongo")),
      [conquer("belgium")],
      [eliminate("germany")],
      [land(0.18)],
    ],
    belgium: [
      hist(conquer("kongo"), land(0.15)),
      [conquer("buganda", "zanzibar")],
      [eliminate("portugal")],
      [land(0.2)],
    ],
    italy: [
      hist(conquer("ottoman_libya")),
      [eliminate("ethiopia")],
      [conquer("mahdist", "zanzibar")],
      [land(0.15)],
    ],
    ethiopia: [hist(conquer("italy"))],
  },
};

// ── Cold War, 1962 ────────────────────────────────────────────────────────
// October 1962: missiles on Cuba. NATO and the Warsaw Pact stand bound to
// their blocs; China and India go their own way.
const COLD_WAR_1962: HistoricalScenario = {
  id: HistoricalScenarioId.ColdWar1962,
  map: GameMapType.World,
  nameKey: "historical_scenario.coldwar1962.name",
  descriptionKey: "historical_scenario.coldwar1962.description",
  oceanHop: 10,
  startingTroopShare: 0.35,
  blocs: [
    { key: "nato", nameKey: "historical_scenario.bloc.nato" },
    { key: "warsaw", nameKey: "historical_scenario.bloc.warsaw" },
  ],
  nations: [
    nation(
      "usa",
      "United States",
      "us",
      true,
      [seed(500, 300), seed(280, 310), seed(400, 360), seed(100, 150, 150)],
      "nato",
    ),
    nation(
      "ussr",
      "Soviet Union",
      "ussr",
      true,
      [
        seed(1300, 200),
        seed(1190, 250),
        seed(1350, 280),
        seed(1700, 172),
        seed(1500, 150),
      ],
      "warsaw",
    ),
    nation("china", "People's Republic of China", "cn", true, [
      seed(1590, 350),
      seed(1450, 330),
    ]),
    nation("uk", "United Kingdom", "gb", true, [seed(955, 215)], "nato"),
    nation("france", "France", "fr", true, [seed(980, 260)], "nato"),
    nation("india", "India", "in", true, [seed(1400, 400)]),
    nation("canada", "Canada", "ca", false, [seed(400, 200)], "nato"),
    nation("frg", "West Germany", "de", false, [seed(1010, 230)], "nato"),
    nation("italy", "Italy", "it", false, [seed(1040, 280)], "nato"),
    nation("turkey", "Turkey", "tr", false, [seed(1150, 300)], "nato"),
    nation("poland", "Poland", "pl", false, [seed(1080, 220)], "warsaw"),
    nation("romania", "Romania", "ro", false, [seed(1110, 260)], "warsaw"),
    nation("cuba", "Cuba", "cu", false, [seed(520, 404)], "warsaw"),
    nation("mongolia", "Mongolia", "mn", false, [seed(1550, 250)], "warsaw"),
    nation("mexico", "Mexico", "mx", false, [seed(400, 420)]),
    nation("brazil", "Brazil", "br", false, [seed(670, 580)]),
    nation("argentina", "Argentina", "ar", false, [seed(600, 730)]),
    nation("spain", "Spain", "es", false, [seed(950, 300)]),
    nation("egypt", "Egypt", "eg", false, [seed(1140, 360)]),
    nation("iran", "Iran", "ir", false, [seed(1280, 340)]),
    nation("saudi", "Saudi Arabia", "sa", false, [seed(1210, 400)]),
    nation("nigeria", "Nigeria", "ng", false, [seed(1000, 490)]),
    nation("south_africa", "South Africa", "za", false, [seed(1100, 700)]),
    nation("japan", "Japan", "jp", false, [seed(1763, 303)]),
    nation("vietnam", "Vietnam", "vn", false, [seed(1580, 450)]),
    nation("indonesia", "Indonesia", "id", false, [seed(1649, 551)]),
    nation("australia", "Australia", "au", false, [seed(1760, 700)]),
  ],
  missions: {
    usa: [
      hist(conquer("cuba", "vietnam")),
      [eliminate("ussr")],
      [conquer("china")],
      [land(0.25)],
    ],
    ussr: [
      hist(conquer("frg")),
      [eliminate("usa")],
      [conquer("iran", "turkey")],
      [land(0.3)],
    ],
    china: [
      hist(conquer("india")),
      [conquer("mongolia", "vietnam")],
      [eliminate("ussr")],
      [land(0.22)],
    ],
    uk: [
      hist(conquer("egypt")),
      [eliminate("ussr")],
      [conquer("india", "south_africa")],
      [land(0.15), cities(25)],
    ],
    france: [
      hist(conquer("nigeria")),
      [conquer("egypt", "spain")],
      [eliminate("ussr")],
      [land(0.15), cities(25)],
    ],
    india: [
      hist(cities(25), land(0.12)),
      [conquer("china", "iran")],
      [eliminate("china")],
      [land(0.22)],
    ],
  },
};

/** Missions for nations without their own: big empire, or a rival's fall. */
export function genericMissions(
  scenario: HistoricalScenario,
  nationKey: string | null,
): MissionDef[] {
  const self =
    nationKey === null
      ? null
      : (scenario.nations.find((n) => n.key === nationKey) ?? null);
  const rivals = scenario.nations.filter(
    (n) =>
      n.major &&
      n.key !== nationKey &&
      (self === null || self.bloc === null || n.bloc !== self.bloc),
  );
  const out: MissionGoal[][] = [[land(0.2)]];
  if (rivals.length >= 1) out.push([eliminate(rivals[0].key)]);
  if (rivals.length >= 3) {
    out.push([conquer(rivals[1].key, rivals[2].key)]);
  }
  return out.map((goals) => ({ goals, historical: false, noteKey: null }));
}

/** At least this many missions to draw from, for variety. */
const MIN_MISSIONS = 3;

/**
 * The missions a player of this nation can be dealt: its own (historical
 * and "what if"), topped up with generic ones where it has fewer than
 * MIN_MISSIONS.
 */
export function missionsFor(
  scenario: HistoricalScenario,
  nationKey: string | null,
): MissionDef[] {
  const own = (
    nationKey === null ? [] : (scenario.missions?.[nationKey] ?? [])
  ).map((spec): MissionDef =>
    Array.isArray(spec)
      ? { goals: spec, historical: false, noteKey: null }
      : {
          goals: spec.goals,
          historical: true,
          noteKey: `missions.note.${scenario.id}.${nationKey}`,
        },
  );
  if (own.length >= MIN_MISSIONS) return own;
  const seen = new Set(own.map((m) => JSON.stringify(m.goals)));
  for (const g of genericMissions(scenario, nationKey)) {
    if (own.length >= MIN_MISSIONS) break;
    if (!seen.has(JSON.stringify(g.goals))) own.push(g);
  }
  return own;
}

export const HISTORICAL_SCENARIOS: Record<
  HistoricalScenarioId,
  HistoricalScenario
> = {
  [HistoricalScenarioId.Europe1939]: EUROPE_1939,
  [HistoricalScenarioId.MareNostrum218]: MARE_NOSTRUM_218,
  [HistoricalScenarioId.Sengoku1560]: SENGOKU_1560,
  [HistoricalScenarioId.Italy1494]: ITALY_1494,
  [HistoricalScenarioId.Britannia800]: BRITANNIA_800,
  [HistoricalScenarioId.Africa1884]: AFRICA_1884,
  [HistoricalScenarioId.ColdWar1962]: COLD_WAR_1962,
};

export function historicalScenario(
  id: HistoricalScenarioId,
): HistoricalScenario {
  return HISTORICAL_SCENARIOS[id];
}

/**
 * The scenario a game plays, or null. A config naming a scenario on another
 * map (or at compact size) plays as a normal game: the coordinates would not
 * fit.
 */
export function scenarioForConfig(
  config: Pick<GameConfig, "historicalScenario" | "gameMap" | "gameMapSize">,
): HistoricalScenario | null {
  if (config.historicalScenario === undefined) return null;
  const scenario = HISTORICAL_SCENARIOS[config.historicalScenario];
  if (scenario === undefined || scenario.map !== config.gameMap) return null;
  if (config.gameMapSize !== GameMapSize.Normal) return null;
  return scenario;
}

/** The scenario nation a player with this flag plays, if any. */
export function scenarioNationByFlag(
  scenario: HistoricalScenario,
  flag: string | null,
): ScenarioNation | null {
  if (flag === null) return null;
  return scenario.nations.find((n) => n.flag === flag) ?? null;
}

/**
 * Which scenario nation each human plays: the host's choices first (in
 * order, each nation and player at most once, unknown ones ignored), then
 * every human left gets the next free nation, great powers first. Humans
 * beyond the number of nations get none and spawn as usual. Deterministic,
 * so every client and the server's replay agree.
 */
export function assignScenarioNations(
  scenario: HistoricalScenario,
  humans: readonly string[],
  assignments: GameConfig["scenarioAssignments"],
): Map<string, ScenarioNation> {
  const result = new Map<string, ScenarioNation>();
  const taken = new Set<string>();
  const humanSet = new Set(humans);
  for (const { clientID, nation } of assignments ?? []) {
    const n = scenario.nations.find((x) => x.key === nation);
    if (
      n === undefined ||
      taken.has(n.key) ||
      !humanSet.has(clientID) ||
      result.has(clientID)
    ) {
      continue;
    }
    result.set(clientID, n);
    taken.add(n.key);
  }
  const free = [
    ...scenario.nations.filter((n) => n.major),
    ...scenario.nations.filter((n) => !n.major),
  ].filter((n) => !taken.has(n.key));
  for (const clientID of humans) {
    if (result.has(clientID)) continue;
    const next = free.shift();
    if (next === undefined) break;
    result.set(clientID, next);
  }
  return result;
}
