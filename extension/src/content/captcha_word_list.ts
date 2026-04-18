export const CAPTCHA_WORD_LIST: string[] = [
  // nature
  'sunset', 'sunrise', 'mountain', 'ocean', 'forest', 'river', 'waterfall', 'meadow', 'valley', 'canyon',
  'desert', 'glacier', 'volcano', 'island', 'lagoon', 'reef', 'rainbow', 'thunder', 'breeze', 'horizon',
  'moonlight', 'starlight', 'aurora', 'snowfall', 'rainfall', 'cloudscape', 'wildflower', 'pinecone', 'seashell', 'sandstone',
  'cliff', 'shoreline', 'tundra', 'prairie', 'marsh', 'grove', 'orchard', 'willow', 'maple', 'cedar',
  'cypress', 'fern', 'moss', 'petal', 'blossom', 'lotus', 'lily', 'pebble', 'crystal', 'amber',
  'jade', 'opal', 'quartz', 'granite', 'marble', 'dune', 'mist', 'fogbank', 'dewdrop', 'raindrop',

  // animals
  'butterfly', 'dragonfly', 'dolphin', 'whale', 'seal', 'otter', 'fox', 'wolf', 'deer', 'rabbit',
  'hedgehog', 'badger', 'swan', 'heron', 'eagle', 'falcon', 'sparrow', 'robin', 'owl', 'penguin',
  'panda', 'koala', 'lemur', 'tiger', 'leopard', 'jaguar', 'gazelle', 'alpaca', 'llama', 'stallion',
  'peacock', 'flamingo', 'parrot', 'hummingbird', 'ladybug', 'beetle', 'firefly', 'seahorse', 'starfish', 'tortoise',
  'cat', 'kitten', 'puppy', 'hamster', 'fawn', 'cub', 'gull', 'loon', 'kingfisher', 'crane',

  // architecture and objects
  'castle', 'palace', 'temple', 'cathedral', 'tower', 'bridge', 'lighthouse', 'windmill', 'cottage', 'villa',
  'courtyard', 'balcony', 'archway', 'staircase', 'library', 'observatory', 'greenhouse', 'workshop', 'market', 'harbor',
  'fountain', 'lantern', 'clocktower', 'pavilion', 'gazebo', 'studio', 'theater', 'museum', 'plaza', 'avenue',
  'caravan', 'sailboat', 'airship', 'tram', 'bicycle', 'compass', 'hourglass', 'teacup', 'notebook', 'postcard',
  'violin', 'harp', 'piano', 'camera', 'mirror', 'vase', 'parasol', 'kettle', 'backpack', 'telescope',

  // sky and cosmos
  'galaxy', 'nebula', 'comet', 'asteroid', 'meteor', 'constellation', 'eclipse', 'moonbeam', 'sunbeam', 'stardust',
  'planet', 'satellite', 'orbit', 'cosmos', 'zenith', 'solstice', 'equinox', 'twilight', 'dawn', 'dusk',
  'midnight', 'daybreak', 'sunflare', 'supernova', 'milkyway', 'moonrise', 'moonset', 'afterglow', 'starfield', 'skylight',

  // food and plants
  'cherry', 'berry', 'apple', 'pear', 'peach', 'plum', 'citrus', 'melon', 'fig', 'olive',
  'lavender', 'vanilla', 'cinnamon', 'ginger', 'mint', 'honey', 'cocoa', 'caramel', 'almond', 'walnut',
  'tea', 'coffee', 'biscuit', 'pastry', 'croissant', 'sorbet', 'jelly', 'pudding', 'toffee', 'cupcake',
  'basil', 'rosemary', 'sage', 'thyme', 'tulip', 'iris', 'orchid', 'violet', 'poppy', 'sunflower',

  // materials and textures
  'silk', 'velvet', 'linen', 'cotton', 'porcelain', 'ceramic', 'glass', 'mirrorwork', 'copper', 'bronze',
  'silver', 'gold', 'ivory', 'pearl', 'satin', 'leather', 'paper', 'ink', 'charcoal', 'pastel',
  'ripple', 'sparkle', 'glimmer', 'reflection', 'shadow', 'pattern', 'mosaic', 'tapestry', 'embroidery', 'filigree',

  // adjectives
  'golden', 'silver', 'crimson', 'azure', 'emerald', 'scarlet', 'violet', 'amber', 'ivory', 'indigo',
  'serene', 'tranquil', 'calm', 'peaceful', 'gentle', 'delicate', 'graceful', 'elegant', 'radiant', 'luminous',
  'ethereal', 'dreamlike', 'mystic', 'enchanted', 'ancient', 'timeless', 'classic', 'ornate', 'grand', 'majestic',
  'vibrant', 'playful', 'joyful', 'bright', 'warm', 'cool', 'soft', 'glossy', 'matte', 'polished',
  'misty', 'foggy', 'glowing', 'shimmering', 'sparkling', 'velvety', 'silken', 'crystalline', 'frosted', 'sunlit',
  'moonlit', 'shadowy', 'vast', 'endless', 'miniature', 'cozy', 'airy', 'layered', 'textured', 'colorful',
  'harmonious', 'balanced', 'detailed', 'refined', 'curious', 'whimsical', 'floral', 'botanical', 'coastal', 'alpine',
  'rustic', 'modern', 'futuristic', 'vintage', 'retro', 'minimal', 'lush', 'verdant', 'breezy', 'feathered',
  'glacial', 'sunny', 'rainy', 'stormy', 'starry', 'cosmic', 'magnetic', 'delightful', 'quiet', 'still',
  'resonant', 'candid', 'festive', 'poetic', 'subtle', 'vivid', 'sleek', 'floating', 'gentle', 'tranquil',
];

const DEFAULT_PROMPT_MIN_WORDS = 8;
const DEFAULT_PROMPT_MAX_WORDS = 10;
const LONG_PROMPT_MIN_WORDS = 205;
const LONG_PROMPT_MAX_WORDS = 240;

function pickRandomIntInclusive(min: number, max: number): number {
  const safeMin = Math.max(1, Math.round(min));
  const safeMax = Math.max(safeMin, Math.round(max));
  return safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
}

export function generateRandomPrompt(wordCount = 0): string {
  const count = wordCount > 0 ? Math.max(1, Math.round(wordCount)) : pickRandomIntInclusive(DEFAULT_PROMPT_MIN_WORDS, DEFAULT_PROMPT_MAX_WORDS);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(CAPTCHA_WORD_LIST[Math.floor(Math.random() * CAPTCHA_WORD_LIST.length)]);
  }
  return words.join(' ');
}

export function generateAutoFarmingPrompt(useLongPromptMode = false): string {
  if (!useLongPromptMode) {
    return generateRandomPrompt();
  }
  return generateRandomPrompt(pickRandomIntInclusive(LONG_PROMPT_MIN_WORDS, LONG_PROMPT_MAX_WORDS));
}
