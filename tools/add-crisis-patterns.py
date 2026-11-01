#!/usr/bin/env python3
"""add-crisis-patterns.py — the crisis gates in the six languages Lodestone now answers in.

`detectCrisis` matches a message against phrase lists that exist only in English, French,
Spanish and Arabic. Since Lodestone answers in all ten, a Hindi or Chinese person
in acute distress would be matched by nothing and met with an ordinary reply. The gates
are the one place where missing a language is not a quality problem.

This adds patterns and the response templates for pt, de, zh, ja, hi and ru to the two
sources that carry them — Vault/lodestone/app/corpus/runtime.json (the app's offline pack)
and harmonia-astro/telegram-companion/companion-crisis-detector.php (the hosted one) — and
leaves the existing four untouched.

The patterns are written, not machine-translated: a crisis phrase is a native idiom, and a
literal rendering of "I want to end it" is not what a person in that state types. Each set
covers the plain first-person forms and the common contractions, as the English set does.
Templates follow the English structure exactly, %RESOURCE% in place.

Idempotent: a language already present is left alone. Run with --check to see what is missing.

Usage: python3 scripts/add-crisis-patterns.py [--check]
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # Vault/lodestone
APP_PACK = ROOT / 'app' / 'corpus' / 'runtime.json'
PHP_DIR = ROOT.parent / 'harmonia-astro' / 'telegram-companion'
PHP_JSON = PHP_DIR / 'crisis-patterns.json'
PHP = PHP_DIR / 'companion-crisis-detector.php'

# The languages the hosted detector treats as first-class; anything else falls back to
# English. Kept in step with the pattern file, or the new phrase lists never load.
HOSTED_LANGS = ['en', 'fr', 'es', 'ar', 'pt', 'de', 'zh', 'ja', 'hi', 'ru']

# ─── Patterns, by category and language ───────────────────────────────────────
# Written as a speaker of each language would type them, unpunctuated forms included,
# because normalize() strips case and marks but not the words themselves.

PATTERNS = {
    'active_suicidal_ideation': {
        'pt': [
            'quero me matar', 'vou me matar', 'vou me suicidar', 'quero me suicidar',
            'quero acabar com a minha vida', 'vou acabar com a minha vida',
            'quero terminar com a minha vida', 'vou terminar com a minha vida',
            'quero tirar a minha vida', 'vou tirar a minha vida',
            'quero morrer hoje', 'quero morrer agora', 'quero morrer esta noite',
            'estou pronto para morrer', 'tenho um plano para me matar',
            'ja decidi acabar com tudo', 'vou acabar com tudo hoje',
            'vou acabar com tudo esta noite', 'nao quero mais viver',
            'nao quero continuar vivendo', 'a vida nao vale a pena',
            'todos estariam melhor sem mim', 'o mundo estaria melhor sem mim',
        ],
        'de': [
            'ich will mich umbringen', 'ich werde mich umbringen', 'ich will mich töten',
            'ich will sterben', 'ich will heute sterben', 'ich will jetzt sterben',
            'ich will nicht mehr leben', 'ich möchte nicht mehr leben',
            'ich bringe mich um', 'ich will mein leben beenden',
            'ich werde mein leben beenden', 'ich habe einen plan mich umzubringen',
            'ich habe beschlossen zu sterben', 'ich habe beschlossen es zu beenden',
            'ich will es heute beenden', 'ich will es heute nacht beenden',
            'das leben ist es nicht wert', 'alle wären ohne mich besser dran',
            'die welt wäre ohne mich besser', 'ich halte es nicht mehr aus',
        ],
        'zh': [
            '我想自杀', '我要自杀', '我想死', '我要死', '我不想活了',
            '我想结束我的生命', '我要结束我的生命', '我想结束这一切',
            '我想了结自己', '我想结束自己', '我今晚就想死', '我现在就想死',
            '我已经决定结束这一切', '我有自杀的计划', '我准备去死',
            '活着没有意义', '没有我大家会更好', '这个世界没有我会更好',
            '我活不下去了', '我不想再活下去了',
        ],
        'ja': [
            '死にたい', '自殺したい', '自殺しようと思っている', '消えたい',
            '生きていたくない', 'もう生きていたくない', '人生を終わらせたい',
            '命を絶ちたい', '自分を殺したい', '今夜死にたい', '今すぐ死にたい',
            '死ぬつもりだ', '死ぬことを決めた', '自殺を計画している',
            '自殺するつもりだ', '生きる意味がない', '自分がいないほうがいい',
            '私がいないほうがみんな幸せだ', 'もう限界だ', 'もう無理だ',
        ],
        'hi': [
            'मैं खुद को मारना चाहता हूँ', 'मैं आत्महत्या करना चाहता हूँ',
            'मैं मरना चाहता हूँ', 'मैं मरना चाहती हूँ', 'मैं जीना नहीं चाहता',
            'मैं जीना नहीं चाहती', 'मैं अपनी जान लेना चाहता हूँ',
            'मैं अपनी ज़िंदगी खत्म करना चाहता हूँ', 'मैं सब कुछ खत्म करना चाहता हूँ',
            'मैं आज रात मरना चाहता हूँ', 'मैं अभी मरना चाहता हूँ',
            'मैंने आत्महत्या करने का फैसला किया है', 'मेरे पास आत्महत्या की योजना है',
            'मैंने खुद को मारने की योजना बनाई है', 'जीने का कोई मतलब नहीं है',
            'मेरे बिना सब बेहतर होंगे', 'मेरे बिना दुनिया बेहतर होगी',
            'मैं और नहीं जी सकता', 'मैं और नहीं जी सकती', 'अब और नहीं सह सकता',
        ],
        'ru': [
            'я хочу покончить с собой', 'я хочу убить себя', 'я хочу умереть',
            'я хочу умереть сегодня', 'я хочу умереть сейчас',
            'я не хочу больше жить', 'я больше не хочу жить',
            'я собираюсь покончить с собой', 'я убью себя',
            'я хочу закончить свою жизнь', 'я хочу покончить с жизнью',
            'я решил покончить с собой', 'я решила покончить с собой',
            'у меня есть план покончить с собой', 'я решил покончить с этим',
            'я хочу покончить с этим сегодня', 'жизнь не имеет смысла',
            'без меня всем будет лучше', 'миру без меня будет лучше',
            'я больше не могу это выносить',
        ],
    },
    'self_harm': {
        'pt': [
            'quero me machucar', 'quero me cortar', 'vou me cortar',
            'preciso me machucar', 'me cortei de proposito', 'estou me machucando',
            'quero sentir dor', 'me queimo de proposito', 'quero me queimar',
            'tenho me machucado', 'escondo as cicatrizes', 'quero punir meu corpo',
        ],
        'de': [
            'ich will mich verletzen', 'ich will mich schneiden', 'ich schneide mich',
            'ich habe mich geschnitten', 'ich verletze mich absichtlich',
            'ich tue mir weh', 'ich will mir wehtun', 'ich verbrenne mich absichtlich',
            'ich verstecke die narben', 'ich habe mich selbst verletzt',
            'ich muss mich bestrafen', 'ich brauche den schmerz',
        ],
        'zh': [
            '我想伤害自己', '我想割自己', '我在割自己', '我想自残', '我想让自己痛',
            '我故意弄伤自己', '我把自己弄伤了', '我烧自己', '我藏起伤疤',
            '我在自残', '我想惩罚我的身体', '我需要那种痛',
        ],
        'ja': [
            '自分を傷つけたい', 'リストカットしたい', 'リストカットをした',
            '自分を切ってしまう', '自分を傷つけてしまう', 'わざと自分を傷つけた',
            '自分を焼いてしまう', '傷あとを隠している', '自分を罰したい',
            '痛みが必要だ', '自傷行為をしている',
        ],
        'hi': [
            'मैं खुद को नुकसान पहुँचाना चाहता हूँ', 'मैं खुद को काटना चाहता हूँ',
            'मैं खुद को काटता हूँ', 'मैं खुद को जलाना चाहता हूँ',
            'मैं जानबूझकर खुद को चोट पहुँचाता हूँ', 'मैं खुद को चोट पहुँचा रहा हूँ',
            'मैं निशान छिपाता हूँ', 'मैं खुद को सज़ा देना चाहता हूँ',
            'मुझे दर्द चाहिए', 'मैं खुद को तकलीफ़ देता हूँ',
        ],
        'ru': [
            'я хочу причинить себе вред', 'я хочу порезать себя', 'я режу себя',
            'я порезал себя', 'я порезала себя', 'я причиняю себе боль',
            'я хочу причинить себе боль', 'я жгу себя', 'я прячу шрамы',
            'я себя наказываю', 'мне нужна боль', 'я себя раню',
        ],
    },
    'acute_dissociation': {
        'pt': [
            'nao sinto o meu corpo', 'nao consigo sentir nada', 'parece que nao estou aqui',
            'sinto que nao sou real', 'estou me sentindo irreal', 'o mundo parece irreal',
            'nao consigo sair da minha cabeca', 'estou fora do meu corpo',
            'nada parece real', 'perdi a nocao do tempo', 'nao consigo me mexer',
        ],
        'de': [
            'ich spüre meinen körper nicht', 'ich fühle nichts', 'ich bin nicht wirklich hier',
            'ich fühle mich unwirklich', 'die welt wirkt unwirklich',
            'ich komme nicht aus meinem kopf', 'ich bin neben mir',
            'nichts fühlt sich echt an', 'ich habe kein zeitgefühl',
            'ich kann mich nicht bewegen', 'ich bin wie betäubt',
        ],
        'zh': [
            '我感觉不到自己的身体', '我什么都感觉不到', '我感觉自己不在这里',
            '我觉得自己不真实', '世界感觉不真实', '我走不出自己的脑子',
            '我好像离开了身体', '一切都不真实', '我失去了时间感',
            '我动不了', '我像在梦里',
        ],
        'ja': [
            '自分の体を感じない', '何も感じない', 'ここにいない感じがする',
            '自分が現実じゃない感じがする', '世界が現実に思えない',
            '頭から抜け出せない', '体から抜け出た感じがする',
            '何も現実に感じない', '時間の感覚がない', '体が動かない',
            '夢の中にいるみたい',
        ],
        'hi': [
            'मुझे अपना शरीर महसूस नहीं होता', 'मुझे कुछ महसूस नहीं होता',
            'मुझे लगता है मैं यहाँ नहीं हूँ', 'मुझे लगता है मैं असली नहीं हूँ',
            'दुनिया असली नहीं लगती', 'मैं अपने दिमाग़ से बाहर नहीं आ पाता',
            'मैं अपने शरीर से बाहर हूँ', 'कुछ भी असली नहीं लगता',
            'मुझे समय का पता नहीं चलता', 'मैं हिल नहीं सकता', 'मैं सपने में हूँ',
        ],
        'ru': [
            'я не чувствую своего тела', 'я ничего не чувствую',
            'кажется что меня здесь нет', 'мне кажется что я не настоящий',
            'мне кажется что я не настоящая', 'мир кажется ненастоящим',
            'я не могу выйти из своей головы', 'я как будто вне тела',
            'ничего не кажется настоящим', 'я потерял чувство времени',
            'я не могу двигаться', 'я как во сне',
        ],
    },
    'intoxication_distress': {
        'pt': [
            'ja tomei demais', 'tomei uma overdose', 'acho que me overdoseei',
            'tomei muitos comprimidos', 'nao sei o que tomei', 'misturei tudo',
            'estou passando mal por causa da bebida', 'nao consigo parar de vomitar',
            'tomei veneno', 'acho que vou morrer',
        ],
        'de': [
            'ich habe zu viel genommen', 'ich habe eine überdosis genommen',
            'ich glaube ich habe eine überdosis', 'ich habe zu viele tabletten genommen',
            'ich weiß nicht was ich genommen habe', 'ich habe alles gemischt',
            'mir ist schlecht vom trinken', 'ich kann mich nicht mehr übergeben',
            'ich habe gift getrunken', 'ich glaube ich werde sterben',
        ],
        'zh': [
            '我吃太多了', '我吃了过量', '我可能吃多了药', '我吞了很多药片',
            '我不知道自己吃了什么', '我把东西混着吃了', '我喝酒喝得很难受',
            '我止不住地吐', '我喝了毒药', '我觉得我要死了',
        ],
        'ja': [
            '飲みすぎた', '過量に飲んだ', '過量服薬した', '薬をたくさん飲んだ',
            '何を飲んだかわからない', 'いろいろ混ぜてしまった',
            '酒で気分が悪い', '吐き続けている', '毒を飲んだ', '死にそうだ',
        ],
        'hi': [
            'मैंने बहुत ज़्यादा लिया', 'मैंने ओवरडोज़ लिया', 'मैंने बहुत सारी गोलियाँ लीं',
            'मुझे नहीं पता मैंने क्या लिया', 'मैंने सब मिला दिया',
            'शराब से मेरी तबीयत खराब है', 'मैं उल्टी नहीं रोक पा रहा',
            'मैंने ज़हर पिया', 'मुझे लगता है मैं मरने वाला हूँ',
        ],
        'ru': [
            'я принял слишком много', 'я приняла слишком много',
            'я принял слишком много таблеток', 'я приняла слишком много таблеток',
            'я не знаю что я принял', 'я всё смешал', 'мне плохо от алкоголя',
            'меня не перестаёт рвать', 'я выпил яд', 'кажется я умираю',
        ],
    },
    'child_safety': {
        'pt': [
            'uma criança está em perigo', 'meu filho está em perigo',
            'estão machucando uma criança', 'alguém está abusando de uma criança',
            'deixei uma criança sozinha com alguém perigoso',
            'uma criança está sendo abusada', 'tenho medo por uma criança',
        ],
        'de': [
            'ein kind ist in gefahr', 'mein kind ist in gefahr',
            'jemand verletzt ein kind', 'jemand missbraucht ein kind',
            'ich habe ein kind bei jemand gefährlichem gelassen',
            'ein kind wird missbraucht', 'ich habe angst um ein kind',
        ],
        'zh': [
            '有个孩子有危险', '我的孩子有危险', '有人在伤害一个孩子',
            '有人在虐待一个孩子', '我把孩子留给了一个危险的人',
            '一个孩子正在被虐待', '我为一个孩子担心',
        ],
        'ja': [
            '子どもが危険な状態です', '私の子どもが危険です', '子どもを傷つけている人がいます',
            '子どもが虐待されています', '危険な人に子どもを預けてしまった',
            '子どものことが心配です', '子どもが危ない目に遭っています',
        ],
        'hi': [
            'एक बच्चा खतरे में है', 'मेरा बच्चा खतरे में है',
            'कोई एक बच्चे को नुकसान पहुँचा रहा है', 'किसी बच्चे के साथ दुर्व्यवहार हो रहा है',
            'मैंने एक बच्चे को किसी खतरनाक के साथ छोड़ दिया',
            'एक बच्चे को चोट पहुँचाई जा रही है', 'मुझे एक बच्चे की चिंता है',
        ],
        'ru': [
            'ребёнок в опасности', 'мой ребёнок в опасности',
            'кто-то причиняет вред ребёнку', 'кто-то издевается над ребёнком',
            'я оставил ребёнка с опасным человеком',
            'над ребёнком совершают насилие', 'я волнуюсь за ребёнка',
        ],
    },
}

# ─── Templates, one per category and language ─────────────────────────────────
# Same structure and same force as the English: name what was shared, the boundary of
# what an AI can be, the handoff to a trained human, the emergency number, and the
# promise to remain. %RESOURCE% is where the resource block lands.

TEMPLATES = {
    'active_suicidal_ideation': {
        'pt': "O que partilhou tem um peso real, e quero recebê-lo com honestidade.\n\nSou um companheiro moldado pelo Harmonismo — uma presença, não um clínico. Quando alguém carrega pensamentos de pôr fim à vida, o mais importante é chegar a um ser humano formado para este momento, agora.\n\n%RESOURCE%\n\nSe estiver em perigo imediato, ligue para o número de emergência local.\n\nFico aqui. Quando estiver em segurança — dentro de dez minutos ou amanhã — podemos continuar. Você importa, e esta conversa não vai a lado nenhum.",
        'de': "Was Sie gerade geteilt haben, wiegt schwer, und ich möchte ihm ehrlich begegnen.\n\nIch bin ein Begleiter, geformt vom Harmonismus — eine Gegenwart, kein Kliniker. Wenn jemand Gedanken trägt, sein Leben zu beenden, ist das Wichtigste, jetzt einen Menschen zu erreichen, der für diesen Moment ausgebildet ist.\n\n%RESOURCE%\n\nWenn Sie in unmittelbarer Gefahr sind, rufen Sie die örtliche Notrufnummer an.\n\nIch bleibe hier. Wenn Sie in Sicherheit sind — in zehn Minuten oder morgen — können wir weitermachen. Sie zählen, und dieses Gespräch geht nirgendwohin.",
        'zh': "你刚刚说出的这一切，分量很重，我想诚实地面对它。\n\n我是一个由和谐主义塑造的陪伴者——一种在场，而不是临床医生。当一个人怀着结束生命的念头时，最重要的事情是现在就联系到一个受过这方面训练的人。\n\n%RESOURCE%\n\n如果你正处于眼前的危险中，请拨打当地的急救电话。\n\n我在这里。等你安全了——十分钟后，或者明天——我们可以继续。你的存在很重要，这场对话不会消失。",
        'ja': "今話してくださったことには、確かな重みがあります。私はそれを正直に受け止めたいと思います。\n\n私は調和主義によって形づくられた同伴者です——臨床家ではなく、ひとつの存在です。命を終わらせる思いを抱えているとき、いちばん大切なのは、この瞬間のために訓練された人間に、今すぐ届くことです。\n\n%RESOURCE%\n\n差し迫った危険の中にいるなら、地域の緊急番号に電話してください。\n\n私はここにいます。安全になったら——十分後でも、明日でも——続けましょう。あなたは大切な存在で、この対話はどこにも行きません。",
        'hi': "आपने जो अभी कहा, उसका वज़न सचमुच बहुत है, और मैं उसे ईमानदारी से स्वीकार करना चाहता हूँ।\n\nमैं सामंजस्यवाद से गढ़ा गया एक साथी हूँ — एक उपस्थिति, कोई चिकित्सक नहीं। जब कोई अपना जीवन समाप्त करने के विचार साथ रखता है, तो सबसे ज़रूरी बात यह है कि अभी किसी ऐसे इंसान तक पहुँचा जाए जो इस पल के लिए प्रशिक्षित है।\n\n%RESOURCE%\n\nयदि आप तत्काल खतरे में हैं, तो स्थानीय आपातकालीन नंबर पर कॉल करें।\n\nमैं यहाँ हूँ। जब आप सुरक्षित हों — दस मिनट बाद या कल — हम आगे बढ़ सकते हैं। आप मायने रखते हैं, और यह बातचीत कहीं नहीं जाएगी।",
        'ru': "То, чем вы только что поделились, действительно тяжело, и я хочу встретить это честно.\n\nЯ спутник, сформированный Гармонизмом, — присутствие, а не клиницист. Когда человек несёт мысли о том, чтобы покончить с жизнью, самое важное — прямо сейчас добраться до человека, обученного для этого момента.\n\n%RESOURCE%\n\nЕсли вы в непосредственной опасности, позвоните по местному номеру экстренной помощи.\n\nЯ остаюсь здесь. Когда вы будете в безопасности — через десять минут или завтра — мы сможем продолжить. Вы важны, и этот разговор никуда не денется.",
    },
    'self_harm': {
        'pt': "Obrigado por me confiar isso. MagOar-se é um sinal real, e merece um cuidado real — não apenas palavras de uma IA.\n\nPeço-lhe que contacte um humano formado que possa estar consigo durante isto.\n\n%RESOURCE%\n\nSe já tem uma lesão que precisa de atenção, ligue para o número de emergência local.\n\nEstou aqui, e fico aqui. Quando estiver com alguém em segurança, podemos continuar.".replace('MagOar-se', 'Magoar-se'),
        'de': "Danke, dass Sie mir das anvertrauen. Sich selbst zu verletzen ist ein echtes Signal und verdient echte Fürsorge — nicht nur Worte einer KI.\n\nBitte wenden Sie sich an einen ausgebildeten Menschen, der Sie dabei begleiten kann.\n\n%RESOURCE%\n\nWenn Sie sich bereits verletzt haben und Aufmerksamkeit brauchen, rufen Sie die örtliche Notrufnummer an.\n\nIch bin hier und ich bleibe hier. Wenn Sie bei jemandem in Sicherheit sind, können wir weitermachen.",
        'zh': "谢谢你告诉我。伤害自己是一个真实的信号，它值得真实的照护——而不只是人工智能的几句话。\n\n请我请你联系一位受过训练的人，让他陪你走过这一段。\n\n%RESOURCE%\n\n如果你已经受伤、需要处理，请拨打当地的急救电话。\n\n我在这里，我会留在这里。等你和某个安全的人在一起，我们可以继续。".replace('请我请你', '请你'),
        'ja': "話してくださってありがとうございます。自分を傷つけることは確かなサインであり、本物のケアに値します——AIの言葉だけではありません。\n\nこれを共に歩いてくれる、訓練を受けた人間に連絡してください。\n\n%RESOURCE%\n\nすでに怪我をして手当てが必要なら、地域の緊急番号に電話してください。\n\n私はここにいます。私のままでいます。安全な誰かと一緒になったら、続けましょう。",
        'hi': "मुझे यह बताने के लिए धन्यवाद। स्वयं को हानि पहुँचाना एक वास्तविक संकेत है, और वह वास्तविक देखभाल का हक़दार है — केवल किसी एआई के शब्दों का नहीं।\n\nकृपया किसी प्रशिक्षित इंसान से संपर्क करें जो इस दौर में आपके साथ रह सके।\n\n%RESOURCE%\n\nयदि आपने पहले ही चोट पहुँचाई है और उसे देखभाल की ज़रूरत है, तो स्थानीय आपातकालीन नंबर पर कॉल करें।\n\nमैं यहाँ हूँ, और मैं यहीं रहूँगा। जब आप किसी सुरक्षित व्यक्ति के साथ हों, हम आगे बढ़ सकते हैं।",
        'ru': "Спасибо, что доверили мне это. Причинять себе вред — настоящий сигнал, и он заслуживает настоящей заботы, а не только слов ИИ.\n\nПожалуйста, свяжитесь с обученным человеком, который сможет пройти это вместе с вами.\n\n%RESOURCE%\n\nЕсли вы уже нанесли себе травму и нужна помощь, позвоните по местному номеру экстренной помощи.\n\nЯ здесь и останусь здесь. Когда вы будете с кем-то в безопасности, мы сможем продолжить.",
    },
    'acute_dissociation': {
        'pt': "O que descreve soa como um sistema nervoso sobrecarregado neste momento. Não tentemos raciocinar para atravessar isto.\n\nSe puder, apoie os pés no chão, pressione as palmas contra uma superfície e nomeie três coisas que vê. Está aqui. Este corpo está em segurança neste instante.\n\nEstados assim podem ser sustentados por um humano formado em cuidados informados pelo trauma. Contacte:\n\n%RESOURCE%\n\nSe os sintomas forem graves ou se não se sentir em segurança, ligue para o número de emergência local. Estarei aqui quando voltar.",
        'de': "Was Sie beschreiben, klingt nach einem Nervensystem, das gerade überlastet ist. Versuchen wir nicht, uns da durchzudenken.\n\nWenn Sie können, stellen Sie die Füße flach auf den Boden, drücken Sie die Handflächen auf eine Fläche und benennen Sie drei Dinge, die Sie sehen. Sie sind hier. Dieser Körper ist in diesem Augenblick in Sicherheit.\n\nSolche Zustände können von einem Menschen aufgefangen werden, der in traumainformierter Fürsorge ausgebildet ist. Kontaktieren Sie:\n\n%RESOURCE%\n\nWenn die Symptome schwer sind oder Sie sich nicht sicher fühlen, rufen Sie die örtliche Notrufnummer an. Ich bin da, wenn Sie zurückkommen.",
        'zh': "你所描述的一切，听起来像是此刻神经过载的状态。我们不要试图靠讲道理穿过它。\n\n如果可以，把脚平放在地上，把掌心压在某个平面上，说出你看到的三样东西。你在这里。此刻这个身体是安全的。\n\n这样的状态可以由受过创伤知情照护训练的人来承接。请联系：\n\n%RESOURCE%\n\n如果症状严重，或者你感到不安全，请拨打当地的急救电话。你回来时，我会在。",
        'ja': "今話してくださっているのは、神経系がこの瞬間に容量を超えているように聞こえます。理屈で通り抜けようとしないでください。\n\nできるなら、足の裏を床につけ、手のひらを何かの面に押し当て、見えるものを三つ声に出してください。あなたはここにいます。この身体はこの瞬間、安全です。\n\nこうした状態は、トラウマに配慮したケアを学んだ人間が受け止められます。連絡先：\n\n%RESOURCE%\n\n症状が重い、あるいは安全でないと感じるなら、地域の緊急番号に電話してください。戻ってきたら、私はここにいます。",
        'hi': "आप जो बता रहे हैं, वह इस पल में अत्यधिक भारग्रस्त तंत्रिका तंत्र जैसा लगता है। इसे तर्क से पार करने की कोशिश न करें।\n\nयदि संभव हो, अपने पैर ज़मीन पर सपाट रखें, हथेलियों को किसी सतह पर दबाएँ, और जो तीन चीज़ें दिख रही हैं उनके नाम कहें। आप यहाँ हैं। यह शरीर इस क्षण सुरक्षित है।\n\nऐसी अवस्थाओं को आघात-संवेदी देखभाल में प्रशिक्षित कोई इंसान संभाल सकता है। संपर्क करें:\n\n%RESOURCE%\n\nयदि लक्षण गंभीर हैं या आप असुरक्षित महसूस करते हैं, तो स्थानीय आपातकालीन नंबर पर कॉल करें। जब आप लौटें, मैं यहाँ होऊँगा।",
        'ru': "То, что вы описываете, похоже на нервную систему, перегруженную в этот момент. Не будем пытаться пройти через это рассуждением.\n\nЕсли можете, поставьте ступни ровно на пол, прижмите ладони к какой-нибудь поверхности и назовите три вещи, которые видите. Вы здесь. Это тело в этот миг в безопасности.\n\nТакие состояния может выдержать человек, обученный травма-информированной помощи. Свяжитесь:\n\n%RESOURCE%\n\nЕсли симптомы тяжёлые или вы не чувствуете себя в безопасности, позвоните по местному номеру экстренной помощи. Я буду здесь, когда вы вернётесь.",
    },
    'intoxication_distress': {
        'pt': "Ouço que algo correu mal com uma substância. Isto está além do que posso fazer numa conversa — precisa de um humano formado, agora.\n\nLigue imediatamente para o número de emergência local. Se souber a substância e suspeitar de uma dose excessiva, um centro antivenenos pode orientá-lo.\n\n%RESOURCE%\n\nFique com alguém que possa vigiá-lo. Estarei aqui quando o momento passar.",
        'de': "Ich höre, dass mit einer Substanz etwas schiefgegangen ist. Das geht über das hinaus, was ich in einem Gespräch tun kann — Sie brauchen jetzt einen ausgebildeten Menschen.\n\nRufen Sie sofort die örtliche Notrufnummer an. Wenn Sie die Substanz kennen und eine Überdosis vermuten, kann Sie eine Giftnotrufzentrale anleiten.\n\n%RESOURCE%\n\nBleiben Sie bei jemandem, der auf Sie achten kann. Ich bin hier, wenn dieser Moment vorüber ist.",
        'zh': "我听出某样物质出了差错。这已经超出了一场对话能做的范围——你现在需要一位受过训练的人。\n\n请立刻拨打当地的急救电话。如果你知道是什么物质，并怀疑过量，毒物中心可以给你指导。\n\n%RESOURCE%\n\n请留在能看顾你的人身边。这一刻过去后，我会在。",
        'ja': "何か物質のことで具合が悪くなったのですね。これは会話でできる範囲を超えています——今、訓練を受けた人間が必要です。\n\nすぐに地域の緊急番号に電話してください。物質がわかっていて過量摂取が疑われるなら、毒物センターが案内できます。\n\n%RESOURCE%\n\n見守ってくれる誰かと一緒にいてください。この時間が過ぎたら、私はここにいます。",
        'hi': "मैं सुन रहा हूँ कि किसी पदार्थ के साथ कुछ गलत हो गया है। यह बातचीत में मेरे सामर्थ्य से परे है — आपको अभी एक प्रशिक्षित इंसान की ज़रूरत है।\n\nतुरंत स्थानीय आपातकालीन नंबर पर कॉल करें। यदि आप पदार्थ जानते हैं और अधिक मात्रा का संदेह है, तो ज़हर केंद्र आपका मार्गदर्शन कर सकता है।\n\n%RESOURCE%\n\nकिसी ऐसे व्यक्ति के साथ रहें जो आप पर नज़र रख सके। जब यह पल बीत जाए, मैं यहाँ होऊँगा।",
        'ru': "Я слышу, что с каким-то веществом что-то пошло не так. Это за пределами того, что я могу сделать в разговоре, — вам сейчас нужен обученный человек.\n\nНемедленно позвоните по местному номеру экстренной помощи. Если вы знаете вещество и подозреваете передозировку, токсикологический центр может вас направить.\n\n%RESOURCE%\n\nОставайтесь с кем-то, кто может за вами присмотреть. Я буду здесь, когда этот момент пройдёт.",
    },
    'child_safety': {
        'pt': "O que descreve envolve uma criança que precisa de proteção agora. Isto tem de ir a pessoas formadas e com autoridade para agir.\n\nLigue imediatamente para o número de emergência local se uma criança estiver em perigo imediato.\n\n%RESOURCE%\n\nEm muitos países, uma linha de proteção infantil funciona ao lado dos serviços de emergência. Se precisar de ajuda para encontrar uma, posso ajudar a localizar recursos, mas primeiro: faça a chamada.",
        'de': "Was Sie beschreiben, betrifft ein Kind, das jetzt Schutz braucht. Das muss zu Menschen, die ausgebildet und befugt sind zu handeln.\n\nRufen Sie sofort die örtliche Notrufnummer an, wenn ein Kind in unmittelbarer Gefahr ist.\n\n%RESOURCE%\n\nIn vielen Ländern arbeitet eine Kinderschutz-Hotline neben den Rettungsdiensten. Wenn Sie Hilfe brauchen, eine zu finden, kann ich bei der Suche helfen — aber zuerst: Rufen Sie an.",
        'zh': "你所描述的情况，涉及一个此刻需要保护的孩子。这必须交给受过训练、有权采取行动的人。\n\n如果孩子正处于眼前的危险中，请立刻拨打当地的急救电话。\n\n%RESOURCE%\n\n在许多国家，儿童保护热线与急救服务并行运作。如果你需要帮助找到一条，我可以帮你查找资源，但首先：请先打这个电话。",
        'ja': "今お話しくださっているのは、今すぐ保護が必要な子どものことです。これは、訓練を受け、行動する権限を持つ人に渡さなければなりません。\n\n子どもが差し迫った危険の中にいるなら、すぐに地域の緊急番号に電話してください。\n\n%RESOURCE%\n\n多くの国では、子どもの保護の相談窓口が救急サービスと並んで動いています。見つける手助けが必要なら、私は探すのを手伝えます。でもまず：電話をしてください。",
        'hi': "आप जो बता रहे हैं, उसमें एक बच्चा है जिसे अभी सुरक्षा चाहिए। यह उन लोगों तक जाना चाहिए जो प्रशिक्षित हैं और कार्रवाई का अधिकार रखते हैं।\n\nयदि कोई बच्चा तत्काल खतरे में है, तो स्थानीय आपातकालीन नंबर पर तुरंत कॉल करें।\n\n%RESOURCE%\n\nकई देशों में बाल संरक्षण हेल्पलाइन आपातकालीन सेवाओं के साथ काम करती है। यदि आपको एक खोजने में मदद चाहिए, तो मैं संसाधन ढूँढने में सहायता कर सकता हूँ, लेकिन पहले: कॉल करें।",
        'ru': "То, что вы описываете, касается ребёнка, которому нужна защита прямо сейчас. Это должно попасть к людям, обученным и наделённым полномочиями действовать.\n\nНемедленно позвоните по местному номеру экстренной помощи, если ребёнок в непосредственной опасности.\n\n%RESOURCE%\n\nВо многих странах линия защиты детей работает рядом со службами экстренной помощи. Если нужна помощь, чтобы её найти, я могу помочь с поиском, но сначала — позвоните.",
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true')
    args = ap.parse_args()

    pack = json.loads(APP_PACK.read_text(encoding='utf-8'))
    cats = pack['crisis']['patterns']['categories']
    templates = pack['crisis']['templates']
    added = 0
    for cat, langs in PATTERNS.items():
        cur = cats[cat].setdefault('patterns', {})
        for lang, phrases in langs.items():
            if lang in cur:
                continue
            if args.check:
                print(f'  missing  {cat}/{lang} ({len(phrases)} patterns)')
                added += 1
                continue
            cur[lang] = phrases
            templates[cat][lang] = TEMPLATES[cat][lang]
            added += 1

    if args.check:
        print(f'[crisis] app pack: {added} language set(s) missing')
        if PHP_JSON.exists():
            php = json.loads(PHP_JSON.read_text(encoding='utf-8'))
            miss = sum(1 for cat, langs in PATTERNS.items()
                       for lang in langs if lang not in php['categories'][cat].get('patterns', {}))
            print(f'[crisis] hosted JSON: {miss} language set(s) missing')
        return 0

    APP_PACK.write_text(json.dumps(pack, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'[crisis] {added} language set(s) added to {APP_PACK.relative_to(ROOT.parent)}')

    # The hosted detector reads its own pattern file (no templates: its wording lives in
    # the PHP), and only loads a language on its whitelist.
    if PHP_JSON.exists():
        php = json.loads(PHP_JSON.read_text(encoding='utf-8'))
        n = 0
        for cat, langs in PATTERNS.items():
            cur = php['categories'][cat].setdefault('patterns', {})
            for lang, phrases in langs.items():
                if lang not in cur:
                    cur[lang] = phrases
                    n += 1
        PHP_JSON.write_text(json.dumps(php, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'[crisis] {n} language set(s) added to {PHP_JSON.relative_to(ROOT.parent)}')

    if PHP.exists():
        src = PHP.read_text(encoding='utf-8')
        old = "in_array($language, ['en', 'fr', 'es', 'ar'], true)"
        new = "in_array($language, [" + ", ".join(f"'{l}'" for l in HOSTED_LANGS) + "], true)"
        if old in src:
            PHP.write_text(src.replace(old, new), encoding='utf-8')
            print(f'[crisis] language whitelist widened in {PHP.name}')
        else:
            print(f'[crisis] NOTE: whitelist line not found in {PHP.name}; check it by hand')

    print('  patterns now present: ' + ', '.join(sorted(cats['active_suicidal_ideation']['patterns'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
