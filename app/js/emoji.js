// Named everyday emoji for the message-sheet tray.
// ponytail: no skin tones or ZWJ sequences. Swap in a CLDR keyword file
// if search misses an emoji people actually use.

const RAW = `
😀 grinning face smile happy
😃 smiley smile happy
😄 smile happy
😁 grin happy
😆 laughing squint
😅 sweat smile nervous
🤣 rofl laugh
😂 joy laugh cry
🙂 slight smile
😉 wink
😊 blush smile
😇 angel halo
🥰 love hearts smile
😍 heart eyes love
🤩 star struck
😘 kiss heart
😗 kiss
😚 kiss
😙 kiss
😋 yum tongue
😛 tongue
😜 wink tongue
🤪 zany
😝 tongue squint
🤑 money
🤗 hug
🤭 giggle
🤫 shush quiet
🤔 thinking
🫡 salute
🤐 zip quiet
🤨 raised eyebrow
😐 neutral
😑 expressionless
😶 no mouth
🫥 dotted
😏 smirk
😒 unamused
🙄 eye roll
😬 grimace
🤥 lying pinocchio
😌 relieved
😔 pensive sad
😪 sleepy
🤤 drool
😴 sleep zzz
😷 mask sick
🤒 thermometer sick
🤕 bandage hurt
🤢 nauseated sick
🤮 vomit sick
🥵 hot
🥶 cold
🥴 woozy
😵 dizzy
🤯 explode mind blown
🤠 cowboy
🥳 party
😎 cool sunglasses
🤓 nerd glasses
🧐 monocle
😕 confused
🫤 diagonal mouth
😟 worried
🙁 frown
😮 open mouth surprised
😯 hushed
😲 astonished surprised
😳 flushed
🥺 pleading
🥹 holding tears
😦 frown open
😧 anguished
😨 fearful scared
😰 anxious cold sweat
😥 sad relieved
😢 cry sad tear
😭 sob cry
😱 scream scared
😖 confounded
😣 persevere
😞 disappointed sad
😓 sweat
😩 weary
😫 tired
🥱 yawn
😤 triumph angry huff
😡 angry rage
😠 angry mad
🤬 swear angry
😈 devil smile
👿 devil angry
💀 skull dead
☠️ skull crossbones
💩 poop
🤡 clown
👹 ogre
👺 goblin
👻 ghost
👽 alien
👾 alien monster
🤖 robot
😺 cat smile
😸 cat grin
😹 cat joy
😻 cat heart
😼 cat smirk
😽 cat kiss
🙀 cat weary
😿 cat cry
😾 cat angry
🙈 see no evil monkey
🙉 hear no evil monkey
🙊 speak no evil monkey
💋 kiss mark lips
💌 love letter
💘 heart arrow cupid
💝 heart ribbon
💖 sparkling heart
💗 growing heart
💓 beating heart
💞 revolving hearts
💕 two hearts
💟 heart decoration
❣️ heart exclamation
💔 broken heart
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🤎 brown heart
🖤 black heart
🤍 white heart
💯 hundred perfect
💢 anger
💥 boom collision
💫 dizzy star
💦 sweat droplets
💨 dash wind
🕳️ hole
💣 bomb
💬 speech balloon
👁️ eye
👀 eyes look
🧠 brain
🦴 bone
🦷 tooth
👅 tongue
👄 mouth lips
👶 baby
🧒 child
👦 boy
👧 girl
🧑 person
👨 man
👩 woman
👴 old man
👵 old woman
👮 police
💂 guard
🥷 ninja
👷 construction worker
🤴 prince
👸 princess
🦸 superhero
🦹 supervillain
🧙 mage wizard
🧚 fairy
🧛 vampire
🧜 merperson
🧝 elf
🧞 genie
🧟 zombie
💆 massage
💇 haircut
🚶 walk
🏃 run
💃 dance woman
🕺 dance man
🧍 stand
🧎 kneel
🧗 climb
🤸 cartwheel gymnastics
🤺 fence fencing
🏇 horse race
⛷️ ski skier
🏂 snowboard
🏋️ lift weights gym
🤼 wrestle wrestling
⛹️ basketball
🤾 handball
🏌️ golf
🏄 surf
🏊 swim
🚣 row boat
🧘 yoga
🛀 bath
🛌 bed sleep
👪 family
👫 couple
🤝 handshake deal
👍 thumb up yes ok
👎 thumb down no
👊 fist punch
✊ raised fist
🤛 left fist
🤜 right fist
👏 clap
🙌 raised hands hooray
🫶 heart hands
👐 open hands
🤲 palms up
🙏 pray thanks please
✍️ write
💅 nail polish
🤳 selfie
💪 muscle strong
🦾 mechanical arm
🦿 mechanical leg
🦵 leg
🦶 foot
👂 ear
👃 nose
🐶 dog
🐱 cat
🐭 mouse
🐹 hamster
🐰 rabbit
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey
🐔 chicken
🐧 penguin
🐦 bird
🐤 chick
🦆 duck
🦅 eagle
🦉 owl
🦇 bat
🐺 wolf
🐗 boar
🐴 horse
🦄 unicorn
🐝 bee
🐛 bug
🦋 butterfly
🐌 snail
🐞 ladybug
🐜 ant
🪲 beetle
🪳 cockroach
🕷️ spider
🕸️ web
🦂 scorpion
🐢 turtle
🐍 snake
🦎 lizard
🐙 octopus
🦑 squid
🦐 shrimp
🦞 lobster
🦀 crab
🐡 blowfish
🐠 fish
🐟 fish
🐬 dolphin
🐳 whale
🦈 shark
🐊 crocodile
🐅 tiger
🐆 leopard
🦓 zebra
🦍 gorilla
🦧 orangutan
🐘 elephant
🦛 hippo
🦏 rhino
🐪 camel
🦒 giraffe
🦘 kangaroo
🦬 bison
🐃 buffalo
🐂 ox
🐄 cow
🐎 horse
🐖 pig
🐏 ram
🐑 sheep
🐐 goat
🦙 llama
🐕 dog
🐩 poodle
🐈 cat
🐓 rooster
🦃 turkey
🦚 peacock
🦜 parrot
🦢 swan
🦩 flamingo
🕊️ dove peace
🐇 rabbit
🦝 raccoon
🦨 skunk
🦡 badger
🦫 beaver
🦦 otter
🦥 sloth
🐁 mouse
🐀 rat
🐿️ chipmunk
🌵 cactus
🎄 christmas tree
🌲 evergreen
🌳 tree
🌴 palm
🌱 seedling
🌿 herb
☘️ shamrock
🍀 clover luck
🍁 maple
🍂 fallen leaf
🍃 leaf wind
🍄 mushroom
🌾 sheaf
💐 bouquet
🌷 tulip
🌹 rose
🥀 wilted rose
🌺 hibiscus
🌸 cherry blossom
🌼 blossom
🌻 sunflower
🌞 sun face
🌝 moon face
🌛 moon
🌜 moon
🌚 moon
🌕 full moon
🌖 moon
🌗 moon
🌘 moon
🌑 new moon
🌒 moon
🌓 moon
🌔 moon
🌙 crescent moon
🌎 earth americas
🌍 earth africa
🌏 earth asia
🪐 saturn planet
⭐ star
🌟 glow star
✨ sparkles
⚡ zap lightning
☄️ comet
🔥 fire hot
💧 droplet water
🌊 ocean wave
🌈 rainbow
☂️ umbrella
☔ umbrella rain
⛄ snowman
❄️ snowflake
☃️ snowman
🌬️ wind
🌀 cyclone
🌪️ tornado
🌫️ fog
☁️ cloud
⛅ sun cloud
⛈️ storm
🌤️ sun cloud
🌥️ cloud
🌦️ rain sun
🌧️ rain
🌨️ snow
🌩️ lightning
🍎 apple
🍐 pear
🍊 orange tangerine
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🫐 blueberry
🍈 melon
🍒 cherries
🍑 peach
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi
🍅 tomato
🍆 eggplant
🥑 avocado
🥦 broccoli
🥬 leafy green
🥒 cucumber
🌶️ hot pepper
🫑 pepper
🌽 corn
🥕 carrot
🫒 olive
🧄 garlic
🧅 onion
🥔 potato
🍠 sweet potato
🥐 croissant
🥯 bagel
🍞 bread
🥖 baguette
🥨 pretzel
🧀 cheese
🥚 egg
🍳 cooking egg
🧈 butter
🥞 pancakes
🧇 waffle
🥓 bacon
🥩 steak meat
🍗 poultry leg
🍖 meat bone
🌭 hot dog
🍔 hamburger burger
🍟 fries
🍕 pizza
🫓 flatbread
🥪 sandwich
🥙 stuffed flatbread
🧆 falafel
🌮 taco
🌯 burrito
🫔 tamale
🥗 salad
🥘 paella
🫕 fondue
🥫 canned food
🍝 spaghetti pasta
🍜 ramen noodles
🍲 stew
🍛 curry
🍣 sushi
🍱 bento
🥟 dumpling
🦪 oyster
🍤 fried shrimp
🍙 rice ball
🍚 rice
🍘 rice cracker
🍥 fish cake
🥠 fortune cookie
🥮 moon cake
🍢 oden
🍡 dango
🍧 shaved ice
🍨 ice cream
🍦 soft ice cream
🥧 pie
🧁 cupcake
🍰 cake
🎂 birthday cake
🍮 custard
🍭 lollipop
🍬 candy
🍫 chocolate
🍿 popcorn
🍩 doughnut
🍪 cookie
🌰 chestnut
🥜 peanuts
🍯 honey
🥛 milk
🍼 baby bottle
🫖 teapot
☕ coffee
🍵 tea
🧃 juice
🥤 cup straw
🧋 bubble tea
🍶 sake
🍺 beer
🍻 beers
🥂 cheers
🍷 wine
🥃 whisky
🍸 cocktail
🍹 tropical drink
🧉 mate
🍾 champagne
🧊 ice
🥄 spoon
🍴 fork knife
🍽️ plate
🥣 bowl
🥡 takeout
🥢 chopsticks
🧂 salt
⚽ soccer football
🏀 basketball
🏈 american football
⚾ baseball
🥎 softball
🎾 tennis
🏐 volleyball
🏉 rugby
🥏 frisbee
🎱 pool billiard
🪀 yo-yo
🏓 ping pong
🏸 badminton
🏒 hockey
🏑 hockey
🥍 lacrosse
🏏 cricket
🪃 boomerang
🥅 goal
⛳ golf
🪁 kite
🏹 bow arrow
🎣 fishing
🤿 diving mask
🥊 boxing
🥋 martial arts
🎽 running shirt
🛹 skateboard
🛼 roller skate
🛷 sled
⛸️ ice skate
🥌 curling
🎿 skis
🪂 parachute
🤽 water polo
🚴 bicycle cycle
🚵 mountain bike
🏆 trophy
🥇 gold medal
🥈 silver medal
🥉 bronze medal
🏅 medal
🎖️ military medal
🏵️ rosette
🎀 ribbon
🎫 ticket
🎟️ admission
🎪 circus
🎭 theater masks
🎨 art palette
🎬 clapper movie
🎤 microphone
🎧 headphone
🎼 music
🎹 piano
🥁 drum
🪘 long drum
🎷 saxophone
🎺 trumpet
🪗 accordion
🎸 guitar
🪕 banjo
🎻 violin
🎲 dice game
♟️ chess
🎯 target direct hit
🎳 bowling
🎮 game controller
🕹️ joystick
🎰 slot machine
🧩 puzzle
🚗 car
🚕 taxi
🚙 suv
🚌 bus
🚎 trolleybus
🏎️ race car
🚓 police car
🚑 ambulance
🚒 fire engine
🚐 van
🛻 pickup truck
🚚 truck
🚛 lorry
🚜 tractor
🛵 scooter
🏍️ motorcycle
🛺 rickshaw
🚲 bicycle
🛴 kick scooter
🚏 bus stop
🛣️ motorway
🛤️ railway
⛽ fuel gas
🚨 police light
🚥 traffic light
🚦 traffic light
🛑 stop sign
⚓ anchor
⛵ sailboat
🛶 canoe
🚤 speedboat
🛳️ ship
⛴️ ferry
🛥️ motor boat
🚢 ship
✈️ airplane flight
🛩️ small airplane
🛫 departure
🛬 arrival
💺 seat
🚁 helicopter
🚟 suspension railway
🚠 mountain cableway
🚡 aerial tramway
🛰️ satellite
🚀 rocket
🛸 flying saucer
🌌 milky way
🌠 shooting star
🎆 fireworks
🎇 sparkler
🎑 moon viewing
🗿 moai
🗽 liberty
🗼 tokyo tower
🏰 castle
🏯 japanese castle
🏟️ stadium
🎡 ferris wheel
🎢 roller coaster
🎠 carousel
⛲ fountain
⛱️ umbrella beach
🏖️ beach
🏝️ island
🏜️ desert
🌋 volcano
⛰️ mountain
🏔️ snow mountain
🗻 fuji
🏕️ camping
⛺ tent
🏠 house
🏡 house garden
🏘️ houses
🏚️ derelict house
🏗️ construction
🏭 factory
🏢 office
🏬 department store
🏣 post office
🏤 post office
🏥 hospital
🏦 bank
🏨 hotel
🏪 convenience store
🏫 school
🏩 love hotel
💒 wedding
⛪ church
🕌 mosque
🕍 synagogue
🛕 hindu temple
🕋 kaaba
⛩️ shinto shrine
🗾 japan
☀️ sun
⌚ watch time
📱 phone mobile
📲 phone arrow
💻 laptop
⌨️ keyboard
🖥️ desktop computer
🖨️ printer
🖱️ mouse computer
🖲️ trackball
💽 minidisc
💾 floppy
💿 cd
📀 dvd
📼 vhs
📷 camera
📸 camera flash
📹 video camera
🎥 movie camera
📽️ film projector
🎞️ film
📞 telephone
☎️ phone
📟 pager
📠 fax
📺 tv television
📻 radio
🎙️ studio mic
🎚️ level slider
🎛️ control knobs
🧭 compass
⏱️ stopwatch
⏲️ timer
⏰ alarm clock
🕰️ mantel clock
⏳ hourglass
⌛ hourglass
📡 satellite antenna
🔋 battery
🪫 low battery
🔌 electric plug
💡 light bulb idea
🔦 flashlight
🕯️ candle
🪔 diya
🧯 fire extinguisher
🛢️ oil drum
💸 money wings
💵 dollar
💴 yen
💶 euro
💷 pound
🪙 coin
💰 money bag
💳 credit card
🧾 receipt
✉️ envelope mail
📧 email
📨 incoming envelope
📩 envelope arrow
📤 outbox
📥 inbox
📦 package
📫 mailbox
📪 mailbox
📬 mailbox
📭 mailbox
📮 postbox
🗳️ ballot box
✏️ pencil
✒️ pen nib
🖋️ fountain pen
🖊️ pen
🖌️ paintbrush
🖍️ crayon
📝 memo note
📁 folder
📂 folder open
📅 calendar
📆 calendar
🗒️ notepad
🗓️ calendar
📇 card index
📈 chart up
📉 chart down
📊 bar chart
📋 clipboard
📌 pin
📍 pin location
📎 paperclip
🖇️ paperclips
📏 ruler
📐 triangle ruler
✂️ scissors
🗃️ card box
🗄️ file cabinet
🗑️ trash delete
🔒 lock
🔓 unlock
🔏 lock pen
🔐 lock key
🔑 key
🗝️ old key
🔨 hammer
🪓 axe
⛏️ pick
⚒️ hammer pick
🛠️ tools
🗡️ dagger
⚔️ swords
🔫 gun
🛡️ shield
🪚 saw
🔧 wrench
🪛 screwdriver
🔩 nut bolt
⚙️ gear
🗜️ clamp
⚖️ balance scale
🦯 white cane
🔗 link
⛓️ chains
🪝 hook
🧰 toolbox
🧲 magnet
🪜 ladder
⚗️ alembic
🧪 test tube
🧫 petri dish
🧬 dna
🔬 microscope
🔭 telescope
💉 syringe
🩸 drop blood
💊 pill
🩹 bandage
🩺 stethoscope
🚪 door
🛗 elevator
🪞 mirror
🪟 window
🛏️ bed
🛋️ couch
🪑 chair
🚽 toilet
🪠 plunger
🚿 shower
🛁 bathtub
🪤 mouse trap
🪒 razor
🧴 lotion
🧷 safety pin
🧹 broom
🧺 basket
🧻 roll paper
🪣 bucket
🧼 soap
🫧 bubbles
🪥 toothbrush
🧽 sponge
🛒 shopping cart
🚬 cigarette
⚰️ coffin
🪦 headstone
⚱️ urn
🧿 nazar
🪬 hamsa
🪧 placard
🏧 atm
🚮 litter
🚰 water potable
♿ wheelchair
🚹 mens
🚺 womens
🚻 restroom
🚼 baby symbol
🚾 wc
🛂 passport control
🛃 customs
🛄 baggage
🛅 left luggage
⚠️ warning
🚸 children crossing
⛔ no entry
🚫 prohibited
🚳 no bicycles
🚭 no smoking
🚯 no litter
🚱 non potable
🚷 no pedestrians
📵 no phones
🔞 no under 18
☢️ radioactive
☣️ biohazard
⬆️ up arrow
↗️ up right arrow
➡️ right arrow
↘️ down right arrow
⬇️ down arrow
↙️ down left arrow
⬅️ left arrow
↖️ up left arrow
↕️ up down
↔️ left right
↩️ return arrow
↪️ return arrow
⤴️ arrow
⤵️ arrow
🔃 clockwise
🔄 repeat arrows
🔙 back
🔚 end
🔛 on
🔜 soon
🔝 top
✅ check mark done
☑️ ballot check
✔️ check
❌ cross no
❎ cross
➕ plus
➖ minus
➗ divide
➰ curly loop
➿ double loop
❓ question
❔ question
❕ exclamation
❗ exclamation
©️ copyright
®️ registered
™️ trademark
#️⃣ hash
*️⃣ asterisk
0️⃣ zero
1️⃣ one
2️⃣ two
3️⃣ three
4️⃣ four
5️⃣ five
6️⃣ six
7️⃣ seven
8️⃣ eight
9️⃣ nine
🔟 ten
🔠 letters
🔡 letters
🔢 numbers
🔣 symbols
🔤 abc
🅰️ a blood
🅱️ b
🆎 ab
🅾️ o
🆑 cl
🆒 cool
🆓 free
ℹ️ information
🆔 id
Ⓜ️ m
🆕 new
🆖 ng
🆗 ok
🅿️ parking
🆘 sos
🆙 up
🆚 vs
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle
🔵 blue circle
🟣 purple circle
🟤 brown circle
⚫ black circle
⚪ white circle
🟥 red square
🟧 orange square
🟨 yellow square
🟩 green square
🟦 blue square
🟪 purple square
🟫 brown square
⬛ black square
⬜ white square
◼️ black medium square
◻️ white medium square
▪️ black small square
▫️ white small square
🔶 large orange diamond
🔷 large blue diamond
🔸 small orange diamond
🔹 small blue diamond
🔺 red triangle
🔻 red triangle down
💠 diamond blue
🔘 radio button
🔳 white square button
🔲 black square button
🏁 checkered flag
🚩 flag triangular
🎌 crossed flags
🏳️ white flag
🏴 black flag
🏳️‍🌈 rainbow flag
`.trim();

export const EMOJI = RAW.split("\n").filter(Boolean).map(line => {
  // The glyph may be a surrogate pair or an emoji plus VS16 (❤️).
  const cut = line.indexOf(" ");
  return { emoji: line.slice(0, cut), name: line.slice(cut + 1) };
});

export function searchEmoji(q) {
  const n = String(q ?? "").trim().toLowerCase();
  if (!n) return EMOJI;
  return EMOJI.filter(e => e.name.includes(n) || e.emoji.includes(n));
}
