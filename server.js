const fs = require('fs');
const xlsx = require('xlsx');
const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const socketIo = require('socket.io');

// إنشاء مجلدات إذا لم تكن موجودة
const publicFolder = path.join(__dirname, 'public');
const downloadsFolder = path.join(publicFolder, 'downloads');
const dataFolder = path.join(__dirname, 'data');

if (!fs.existsSync(publicFolder)) {
    fs.mkdirSync(publicFolder, { recursive: true });
}

if (!fs.existsSync(downloadsFolder)) {
    fs.mkdirSync(downloadsFolder, { recursive: true });
}

if (!fs.existsSync(dataFolder)) {
    fs.mkdirSync(dataFolder, { recursive: true });
}

// مسار ملف قاعدة البيانات JSON
const dbFilePath = path.join(dataFolder, 'offers.json');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));
app.use(express.json());

// حذف مجلد المصادقة القديم إذا كان موجوداً
const oldAuthPath = path.join(__dirname, '.wwebjs_auth');
if (fs.existsSync(oldAuthPath)) {
    try {
        fs.rmSync(oldAuthPath, { recursive: true, force: true });
        console.log('🗑️ تم حذف مجلد المصادقة القديم.');
    } catch (error) {
        console.warn('⚠️ تعذر حذف مجلد المصادقة القديم:', error.message);
    }
}

// تهيئة مجلد المصادقة الجديد بطريقة آمنة
const newAuthPath = path.join(__dirname, '.wwebjs_auth_new');
if (!fs.existsSync(newAuthPath)) {
    fs.mkdirSync(newAuthPath, { recursive: true });
} else {
    // محاولة تنظيف ملف السجل المشكل بشكل آمن
    try {
        const debugLogPath = path.join(newAuthPath, 'session-real-estate-client', 'Default', 'chrome_debug.log');
        if (fs.existsSync(debugLogPath)) {
            try {
                fs.unlinkSync(debugLogPath);
            } catch (error) {
                console.warn('⚠️ لم نتمكن من حذف ملف السجل، سيتم تجاهله:', error.message);
            }
        }
    } catch (error) {
        console.warn('⚠️ خطأ عند محاولة تنظيف ملفات المصادقة:', error.message);
    }
}

// إنشاء عميل واتساب مع خيارات محسنة
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'real-estate-client',
        dataPath: newAuthPath
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-features=site-per-process',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--start-maximized',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
            '--user-data-dir='
        ],
        defaultViewport: null,
        protocolTimeout: 30000,
        ignoreDefaultArgs: ['--enable-automation'],
        slowMo: 0,
    },
    webVersion: '2.2417.7',
    webVersionCache: {
        type: 'local',
    },
    qrMaxRetries: 2,
    qrTimeoutMs: 120000,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    bypassCSP: true
});
// معالجة الخروج من واتساب
client.on('disconnected', async (reason) => {
    console.log('🔌 انقطع الاتصال:', reason);
    io.emit('disconnected', 'انقطع الاتصال بواتساب. جاري إعادة الاتصال...');
    
    serverStatus.isConnected = false;
    serverStatus.lastUpdated = new Date();
    serverStatus.lastMessage = reason;
    
    // إيقاف مؤقت قبل إعادة المحاولة
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    if (serverStatus.reconnectAttempts < serverStatus.maxReconnectAttempts) {
        serverStatus.reconnectAttempts++;
        console.log(`🔄 محاولة إعادة الاتصال ${serverStatus.reconnectAttempts}/${serverStatus.maxReconnectAttempts}`);
        
        try {
            // مسح الملفات المؤقتة قبل إعادة المحاولة
            const sessionFolderPath = path.join(newAuthPath, 'session-real-estate-client');
            if (fs.existsSync(sessionFolderPath)) {
                try {
                    // حذف ملف السجل المشكل فقط (بدلاً من حذف المجلد بأكمله)
                    const debugLogPath = path.join(sessionFolderPath, 'Default', 'chrome_debug.log');
                    if (fs.existsSync(debugLogPath)) {
                        fs.unlinkSync(debugLogPath);
                    }
                } catch (error) {
                    console.warn('⚠️ لم نتمكن من حذف ملف السجل:', error.message);
                }
            }
            
            // إعادة تهيئة العميل
            await client.initialize().catch(err => {
                console.error('❌ خطأ أثناء إعادة تهيئة العميل:', err);
            });
        } catch (error) {
            console.error('❌ خطأ خلال محاولة إعادة التهيئة:', error);
        }
    } else {
        io.emit('reconnect_failed', 'فشلت جميع محاولات إعادة الاتصال. يرجى إعادة تشغيل الجلسة يدويًا.');
    }
});

// معالجة فشل المصادقة
client.on('auth_failure', async (msg) => {
    console.error('❌ فشل المصادقة:', msg);
    io.emit('auth_failure', 'فشل المصادقة، جاري إعادة التهيئة...');
    
    // إيقاف مؤقت قبل إعادة المحاولة
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    try {
        await client.initialize().catch(err => {
            console.error('❌ خطأ أثناء إعادة تهيئة العميل بعد فشل المصادقة:', err);
        });
    } catch (error) {
        console.error('❌ خطأ خلال محاولة إعادة التهيئة بعد فشل المصادقة:', error);
    }
});
// حفظ حالة الجلسة بشكل دوري
setInterval(() => {
    if (serverStatus.isConnected) {
        console.log('💾 حفظ حالة الجلسة...');
        saveOffersToDatabase();
    }
}, 300000); // كل 5 دقائق
// قائمة لحفظ الرسائل العقارية
let realEstateOffers = [];
let messageStats = { total: 0, sale: 0, rent: 0, phone: 0 };
let phoneNumbers = new Set(); // لتتبع أرقام الهواتف الفريدة
let processedMessageIds = new Set(); // لتجنب تكرار المعالجة

// إنشاء متغير عمومي لتخزين أحدث رمز QR
let latestQR = null;

// حالة السيرفر
let serverStatus = {
    isConnected: false,
    lastUpdated: new Date(),
    lastMessage: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5
};

// تحميل العروض المحفوظة من قبل (إن وجدت)
function loadSavedOffers() {
    try {
        if (fs.existsSync(dbFilePath)) {
            const savedData = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
            realEstateOffers = savedData.offers || [];
            
            // استعادة أرقام الهواتف الفريدة
            phoneNumbers = new Set(savedData.phoneNumbers || []);
            
            // استعادة قائمة معرفات الرسائل المعالجة
            processedMessageIds = new Set(savedData.processedMessageIds || []);
            
            // تحديث الإحصائيات
            messageStats = {
                total: realEstateOffers.length,
                sale: realEstateOffers.filter(offer => offer["نوع العرض"] === "بيع").length,
                rent: realEstateOffers.filter(offer => offer["نوع العرض"] === "إيجار").length,
                phone: phoneNumbers.size
            };
            
            console.log(`📂 تم تحميل ${realEstateOffers.length} عرض عقاري من قاعدة البيانات`);
        }
    } catch (error) {
        console.error('❌ خطأ في تحميل العروض المحفوظة:', error.message);
    }
}

// حفظ العروض في قاعدة البيانات
function saveOffersToDatabase() {
    try {
        const dataToSave = {
            offers: realEstateOffers,
            phoneNumbers: Array.from(phoneNumbers),
            processedMessageIds: Array.from(processedMessageIds),
            lastUpdated: new Date()
        };
        
        fs.writeFileSync(dbFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
        console.log(`💾 تم حفظ ${realEstateOffers.length} عرض عقاري في قاعدة البيانات`);
    } catch (error) {
        console.error('❌ خطأ في حفظ العروض:', error.message);
    }
}

// الكلمات المفتاحية للعقارات
const realEstateKeywords = [
    "للبيع", "للايجار", "للإيجار", "للتأجير", "للشراء", "ارض", "أرض", "فيلا", "شقة", "شقه", 
    "عمارة", "عقار", "متر", "م²", "مخطط", "مساحة", "مستودع", "استراحة", "دور", "غرف", 
    "مليون", "الف", "ألف", "ريال", "سكني", "تجاري", "عقاري", "مكتب", "محل", "مول"
];

// دالة محسنة للتحقق من وجود كلمة مفتاحية في النص
function containsRealEstateKeywords(text) {
    if (!text || text.length < 30) return false; // استبعاد الرسائل القصيرة جدًا
    
    // تحويل النص إلى أحرف صغيرة للمقارنة
    const lowerText = text.toLowerCase();
    
    // استبعاد الرسائل الدينية والإعلانية الشائعة
    const excludedKeywords = [
        "اللهم", "الحمد لله", "سبحان الله", "استغفر الله", "صلى الله عليه وسلم",
        "وظائف", "تخفيضات", "عروض", "خصم", "وظيفة", "توظيف"
    ];
    
    if (excludedKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
        return false;
    }
    
    // التأكد من وجود أرقام في النص (أسعار، مساحات)
    const hasNumbers = /\d+/.test(text);
    if (!hasNumbers) return false;
    
    // فئات الكلمات المفتاحية
    const propertyTypes = ["شقة", "فيلا", "أرض", "ارض", "عمارة", "شاليه", "مستودع", "محل", "مكتب", "استراحة"];
    const transactionTypes = ["للبيع", "للايجار", "للإيجار", "للشراء", "للتأجير", "إيجار", "بيع"];
    const measurementTerms = ["متر", "م²", "م2", "مساحة", "المساحة", "مساحته", "مساحتها"];
    const priceTerms = ["ريال", "مليون", "الف", "ألف", "سعر", "السعر", "بسعر", "قيمة", "بقيمة"];
    
    // فحص وجود كلمات من فئات مختلفة - تحسين للتأكد من وجود أكثر من فئة
    let matchedCategories = 0;
    
    if (propertyTypes.some(word => lowerText.includes(word.toLowerCase()))) matchedCategories++;
    if (transactionTypes.some(word => lowerText.includes(word.toLowerCase()))) matchedCategories++;
    if (measurementTerms.some(word => lowerText.includes(word.toLowerCase()))) matchedCategories++;
    if (priceTerms.some(word => lowerText.includes(word.toLowerCase()))) matchedCategories++;
    
    // يجب توفر على الأقل فئتين من الفئات المختلفة
    return matchedCategories >= 2;
}

// دالة محسنة لاستخراج رقم الهاتف
function extractPhoneNumber(text) {
    if (!text) return "غير متوفر";
    
    // نمط متقدم لاستخراج أرقام الهواتف السعودية
    const phonePatterns = [
        /((\+|00)?966|0)5\d{8}/g,                    // أرقام سعودية بأشكال مختلفة
        /(?<!\d)5\d{8}(?!\d)/g,                      // أرقام تبدأ بـ 5 متبوعة بـ 8 أرقام
        /(\+|00)?966(5\d{8})/g,                      // أرقام بمفتاح دولي
        /واتس[اآ]ب[\s:]*[+]?[\d\s]{10,}/gi,         // أرقام بعد كلمة واتساب
        /[تج]واصل[\s:]*[+]?[\d\s]{10,}/gi,          // أرقام بعد كلمة تواصل
        /(?:للتواصل|الجوال|موبايل|رقم|اتصال)[\s:]*[+]?[\d\s]{10,}/gi // أرقام بعد كلمات شائعة
    ];
    
    for (const pattern of phonePatterns) {
        const matches = text.match(pattern);
        if (matches && matches.length > 0) {
            // تنظيف الرقم (إزالة المسافات والرموز غير الضرورية)
            let phone = matches[0].replace(/[^\d]/g, '');
            
            // التأكد من صيغة الرقم السعودي
            if (phone.startsWith('00966')) {
                phone = phone.substring(5);
            } else if (phone.startsWith('+966')) {
                phone = phone.substring(4);
            } else if (phone.startsWith('966')) {
                phone = phone.substring(3);
            }
            
            // إضافة 0 إذا كان الرقم يبدأ بـ 5 مباشرة
            if (phone.startsWith('5') && phone.length === 9) {
                phone = '0' + phone;
            }
            
            // التحقق من طول الرقم (يجب أن يكون 10 أرقام للأرقام السعودية مع الصفر البادئ)
            if (phone.length === 10 && phone.startsWith('05')) {
                return phone;
            }
        }
    }
    
    return "غير متوفر";
}

// دالة محسنة لاستخراج المساحة
function extractArea(text) {
    if (!text) return "غير محدد";
    
    // أنماط مختلفة لاستخراج المساحة
    const areaPatterns = [
        // نمط: مساحة: 500 متر مربع
        /(?:مساحة|المساحه|المساحة|بمساحة|مساحته|مساحتها)\s*[:]\s*(\d[\d,.]*)(?:\s*(?:متر|م|م2|متر مربع|م²))/i,
        
        // نمط: المساحة 500 متر
        /(?:مساحة|المساحه|المساحة|بمساحة|مساحته|مساحتها)\s+(\d[\d,.]*)(?:\s*(?:متر|م|م2|متر مربع|م²))/i,
        
        // نمط: 500 متر مربع
        /(\d[\d,.]*)\s*(?:متر|م|م²|م2)(?:\s*(?:مربع|²))?/i
    ];
    
    for (const pattern of areaPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            // تنظيف القيمة من الفواصل والنقاط
            return match[1].replace(/[,.]/g, '');
        }
    }
    
    return "غير محدد";
}

// دالة محسنة لاستخراج السعر
function extractPrice(text) {
    if (!text) return "غير محدد";
    
    // أنماط مختلفة لاستخراج السعر
    const pricePatterns = [
        // نمط: السعر: 500000 ريال
        /(?:السعر|سعر|مطلوب|ب|بسعر|قيمة|بقيمة|المطلوب)\s*[:]\s*(\d[\d,.]*)(?:\s*(?:مليون|الف|ألف|ريال|ر\.س|ر.س.|ر|ريال سعودي|جنيه|دولار|درهم))?/i,
        
        // نمط: السعر 500000 ريال
        /(?:السعر|سعر|مطلوب|ب|بسعر|قيمة|بقيمة|المطلوب)\s+(\d[\d,.]*)(?:\s*(?:مليون|الف|ألف|ريال|ر\.س|ر.س.|ر|ريال سعودي|جنيه|دولار|درهم))?/i,
        
        // نمط: بـ 500000 ريال
        /\bبـ\s*(\d[\d,.]*)(?:\s*(?:مليون|الف|ألف|ريال|ر\.س|ر.س.|ر|ريال سعودي|جنيه|دولار|درهم))/i,
        
        // نمط: 500000 ريال
        /(\d[\d,.]*)\s*(?:مليون|الف|ألف|ريال|ر\.س|ر.س.|ر|ريال سعودي|جنيه|دولار|درهم)/i
    ];
    
    for (const pattern of pricePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            // تنظيف القيمة من الفواصل والنقاط
            const cleanValue = match[1].replace(/[,.]/g, '');
            
            // التحقق من وجود كلمة "مليون" بعد الرقم
            if (text.includes("مليون") && match.index + match[0].length + 10 >= text.indexOf("مليون")) {
                // ضرب القيمة بمليون
                return (Number(cleanValue) * 1000000).toString();
            }
            
            // التحقق من وجود كلمة "ألف" أو "الف" بعد الرقم
            if ((text.includes("ألف") || text.includes("الف")) && 
                (match.index + match[0].length + 10 >= text.indexOf("ألف") || 
                 match.index + match[0].length + 10 >= text.indexOf("الف"))) {
                // ضرب القيمة بألف
                return (Number(cleanValue) * 1000).toString();
            }
            
            return cleanValue;
        }
    }
    
    return "غير محدد";
}

// دالة محسنة لاستخراج الموقع
function extractLocation(text) {
    if (!text) return "غير محدد";
    
    // القائمة الأساسية للمناطق والمدن السعودية
    const saudiCities = [
        "الرياض", "جدة", "مكة", "المدينة", "الدمام", "الخبر", "جازان", "تبوك", "القصيم", "حائل", "عسير",
        "أبها", "الطائف", "نجران", "الجبيل", "الاحساء", "ينبع", "بريدة", "الخرج", "حفر الباطن", "الجوف",
        "عرعر", "الباحة", "سكاكا", "جيزان", "خميس مشيط", "المجمعة", "شقراء", "رماح", "رأس تنورة", "القطيف"
    ];
    
    // أنماط البحث المختلفة
    const locationPatterns = [
        // نمط: في/بـ <الموقع>
        /(?:في|بـ|حي|منطقة|مخطط|شارع|طريق|مدينة|مدينه|بمدينة)\s+([^\d\n,.،]+?)(?:\s+|$|،|,|\.|٫)/i,
        
        // نمط: الموقع: <الموقع>
        /(?:الموقع|العنوان|المكان|الحي)[:]\s+([^\d\n,.،]+?)(?:\s+|$|،|,|\.|٫)/i
    ];
    
    // البحث أولاً عن المدن الرئيسية
    for (const city of saudiCities) {
        if (text.includes(city)) {
            return city;
        }
    }
    
    // ثم البحث باستخدام الأنماط
    for (const pattern of locationPatterns) {
        const match = text.match(pattern);
        
        if (match && match[1] && match[1].length > 2 && match[1].length < 30) {
            const location = match[1].trim();
            
            // استبعاد النتائج غير المنطقية
            const invalidLocations = ["التواصل", "الواتس", "للتواصل", "الاتصال", "الرقم"];
            if (!invalidLocations.some(invalid => location.includes(invalid))) {
                return location;
            }
        }
    }
    
    return "غير محدد";
}

// دالة محسنة لتحديد نوع العقار
function extractPropertyType(text) {
    if (!text) return "غير محدد";
    
    const lowerText = text.toLowerCase();
    
    const propertyTypes = {
        "شقة": ["شقة", "شقه", "شقق", "دور", "دوبلكس", "روف", "دوبلكس", "بنتهاوس", "شقة مفروشة", "استديو"],
        "فيلا": ["فيلا", "فلل", "فيلل", "فلة", "قصر", "منزل", "بيت", "دوبلكس", "تاون هاوس", "فيلا دوبلكس"],
        "أرض": ["أرض", "ارض", "قطعة", "قطعه", "قطع اراضي", "قطع أراضي", "أرض فضاء", "صك", "مخطط"],
        "عمارة": ["عمارة", "عماره", "عمائر", "بناية", "بنايه", "برج", "إسكان", "اسكان", "مبنى", "مبنى سكني"],
        "محل تجاري": ["محل", "معرض", "محلات", "معارض", "مول", "سوق", "محل تجاري", "دور أرضي تجاري"],
        "مكتب": ["مكتب", "مكاتب", "أوفيس", "اوفيس", "مقر", "مكتب إداري", "برج إداري", "مكتب تجاري"],
        "استراحة": ["استراحة", "استراحه", "شاليه", "مزرعة", "مزرعه", "قاعة", "قاعه", "منتجع", "استراحات"],
        "مستودع": ["مستودع", "مستودعات", "هناجر", "هنجر", "مخزن", "مخازن", "ورشة", "ورشه", "مصنع"]
    };
    
    // البحث عن أطول تطابق ممكن في النص
    let maxMatchLength = 0;
    let bestMatchType = "غير محدد";
    
    for (const [type, keywords] of Object.entries(propertyTypes)) {
        for (const keyword of keywords) {
            if (lowerText.includes(keyword.toLowerCase())) {
                if (keyword.length > maxMatchLength) {
                    maxMatchLength = keyword.length;
                    bestMatchType = type;
                }
            }
        }
    }
    
    return bestMatchType;
}

// دالة محسنة لتحديد نوع العرض (بيع/إيجار)
function extractOfferType(text) {
    if (!text) return "غير محدد";
    
    const lowerText = text.toLowerCase();

    const saleKeywords = ["للبيع", "بيع", "تمليك", "يبيع", "عرض بيع", "معروض للبيع", "البيع", "يعرض", "بسعر"];
    const rentKeywords = ["للايجار", "للإيجار", "للتأجير", "ايجار", "إيجار", "تأجير", "مؤجر", "للإجار", "استئجار"];
    const buyKeywords = ["شراء", "للشراء", "أرغب بشراء", "يبغى يشتري", "أريد شراء", "مطلوب شراء", "مطلوب", "ابغى"];

    // التحقق من نوع العرض بناءً على وجود الكلمات المفتاحية
    if (saleKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
        return "بيع";
    } else if (rentKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
        return "إيجار";
    } else if (buyKeywords.some(keyword => lowerText.includes(keyword.toLowerCase()))) {
        return "شراء";
    }

    // إذا لم يتم العثور على كلمات مفتاحية واضحة، التحقق من النص بطرق أخرى
    if (lowerText.includes("بسعر") || lowerText.includes("سعر") || lowerText.includes("مليون") || lowerText.includes("صك")) {
        return "بيع"; // النص يتحدث عن سعر وصك، الأرجح أنه بيع
    }

    return "غير محدد";
}

// دالة لتحديد عدد الغرف
function extractRooms(text) {
    if (!text) return "غير محدد";
    
    const roomPatterns = [
        /(\d+)\s*غرف(?:ة|ه)?/i,
        /غرف(?:ة|ه)?\s*(?:النوم|نوم)?[:]\s*(\d+)/i,
        /(?:تتكون من|مكونة من|تتألف من|تحتوي على)\s*(\d+)\s*غرف(?:ة|ه)?/i,
        /(\d+)\s*(?:بد روم|بدروم|غرفة نوم|غرف نوم|غرفة|غرفه)/i
    ];
    
    for (const pattern of roomPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return "غير محدد";
}

// دالة لتحديد عدد دورات المياه
function extractBathrooms(text) {
    if (!text) return "غير محدد";
    
    const bathroomPatterns = [
        /(\d+)\s*(?:دورة مياه|دورات مياه|حمام|حمامات|دورة|دورات)/i,
        /(?:دورة مياه|دورات مياه|حمام|حمامات|دورة|دورات)[:]\s*(\d+)/i,
        /(?:تحتوي على|فيها|بها)\s*(\d+)\s*(?:دورة مياه|دورات مياه|حمام|حمامات|دورة|دورات)/i
    ];
    
    for (const pattern of bathroomPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    
    return "غير محدد";
}

// دالة لتحليل رسالة عقارية
function analyzeRealEstateMessage(messageText, groupName, sender, timestamp, messageId) {
    // تجنب تكرار معالجة نفس الرسالة
    if (processedMessageIds.has(messageId)) {
        return null;
    }
    
    // إضافة معرف الرسالة إلى مجموعة الرسائل المعالجة
    processedMessageIds.add(messageId);
    
    const offerType = extractOfferType(messageText);
    const propertyType = extractPropertyType(messageText);
    const location = extractLocation(messageText);
    const area = extractArea(messageText);
    const price = extractPrice(messageText);
    const phoneNumber = extractPhoneNumber(messageText);
    const rooms = extractRooms(messageText);
    const bathrooms = extractBathrooms(messageText);
    
    // تحديث الإحصائيات
    messageStats.total++;
    if (offerType === "بيع") messageStats.sale++;
    if (offerType === "إيجار") messageStats.rent++;
    
    // تتبع أرقام الهواتف الفريدة
    if (phoneNumber !== "غير متوفر" && !phoneNumbers.has(phoneNumber)) {
        phoneNumbers.add(phoneNumber);
        messageStats.phone++;
    }
    
    // إنشاء كائن العرض العقاري
    return {
        "نوع العرض": offerType,
        "نوع العقار": propertyType,
        "الموقع": location,
        "المساحة": area,
        "السعر": price,
        "عدد الغرف": rooms,
        "دورات المياه": bathrooms,
        "رقم الهاتف": phoneNumber,
        "المجموعة": groupName,
        "المرسل": sender,
        "التاريخ": timestamp,
        "معرف الرسالة": messageId,
        "النص الكامل": messageText
    };
}

// حدث QR - تحسين توليد وعرض رمز QR
client.on('qr', async (qr) => {
    console.log('📱 تم توليد رمز QR جديد');
    
    try {
        // تحسين جودة رمز QR
        const qrDataUrl = await qrcode.toDataURL(qr, {
            margin: 3,
            scale: 8,
            errorCorrectionLevel: 'H', // أعلى مستوى تصحيح للخطأ
            color: {
                dark: '#25D366',  // لون واتساب الأخضر
                light: '#FFFFFF'  // لون خلفية أبيض
            }
        });
        
        // تخزين أحدث رمز QR
        latestQR = qrDataUrl;
        
        // إرسال رمز QR للواجهة الأمامية
        io.emit('qr', qrDataUrl);
        
        // تحديث حالة السيرفر
        serverStatus.lastUpdated = new Date();
        serverStatus.isConnected = false;
        
    } catch (error) {
        console.error('❌ خطأ في توليد رمز QR:', error.message);
        io.emit('error', 'حدث خطأ أثناء توليد رمز QR');
    }
});

// معالجة حالة التحميل
client.on('loading_screen', (percent, message) => {
    console.log(`🔄 جاري التحميل: ${percent}% - ${message}`);
    io.emit('loading', { percent, message });
});

// معالجة حالة الاستعداد
client.on('ready', () => {
    console.log('✅ تم تسجيل الدخول والاتصال بنجاح!');
    io.emit('ready', 'تم تسجيل الدخول بنجاح! البرنامج جاهز للعمل');
    
    // تحديث حالة السيرفر
    serverStatus.isConnected = true;
    serverStatus.lastUpdated = new Date();
    serverStatus.reconnectAttempts = 0;
    
    // تحميل العروض المحفوظة
    loadSavedOffers();
    
    // إرسال الإحصائيات المحدثة للواجهة
    io.emit('message_stats', messageStats);
});

// معالجة فشل المصادقة
client.on('auth_failure', msg => {
    console.error('❌ فشل المصادقة:', msg);
    io.emit('auth_failure', 'فشل المصادقة، جاري إعادة التهيئة...');
    
    // إعادة تهيئة العميل بعد 3 ثوانٍ
    setTimeout(() => {
        try {
            client.initialize().catch(err => {
                console.error('❌ خطأ أثناء إعادة تهيئة العميل:', err);
            });
        } catch (error) {
            console.error('❌ خطأ خلال محاولة إعادة التهيئة:', error);
        }
    }, 3000);
});

// معالجة قطع الاتصال
client.on('disconnected', (reason) => {
    console.log('🔌 انقطع الاتصال:', reason);
    io.emit('disconnected', 'انقطع الاتصال بواتساب. جاري إعادة الاتصال...');
    
    // تحديث حالة الاتصال
    serverStatus.isConnected = false;
    serverStatus.lastUpdated = new Date();
    
    // محاولة إعادة الاتصال إذا كان عدد المحاولات أقل من الحد الأقصى
    if (serverStatus.reconnectAttempts < serverStatus.maxReconnectAttempts) {
        serverStatus.reconnectAttempts++;
        
        setTimeout(() => {
            try {
                console.log(`🔄 محاولة إعادة الاتصال ${serverStatus.reconnectAttempts}/${serverStatus.maxReconnectAttempts}`);
                client.initialize().catch(err => {
                    console.error('❌ خطأ أثناء إعادة تهيئة العميل:', err);
                });
            } catch (error) {
                console.error('❌ خطأ خلال محاولة إعادة التهيئة:', error);
            }
        }, 3000);
    } else {
        io.emit('reconnect_failed', 'فشلت جميع محاولات إعادة الاتصال. يرجى إعادة تشغيل الجلسة يدويًا.');
    }
});

// نقاط نهاية API جديدة

// نقطة نهاية للحصول على رمز QR مباشرة
app.get('/api/get-qr', (req, res) => {
    if (latestQR) {
        res.json({ success: true, qrData: latestQR });
    } else {
        res.status(404).json({ 
            success: false, 
            error: 'لم يتم توليد رمز QR بعد. حاول مرة أخرى بعد بضع ثوانٍ.' 
        });
    }
});

// صفحة تصدير العروض إلى إكسل
// صفحة تصدير العروض إلى إكسل
app.get('/export', (req, res) => {
    try {
        // التحقق من وجود عروض للتصدير
        if (realEstateOffers.length === 0) {
            return res.status(400).send('لا توجد عروض عقارية للتصدير');
        }
        
        console.log(`📊 بدء تصدير ${realEstateOffers.length} عرض عقاري إلى إكسل`);
        
        // تحقق مما إذا كان التصدير مصفى
        const isFiltered = req.query.filtered === 'true';
        
        // معايير التصفية
        const offerType = req.query.offerType;
        const propertyType = req.query.propertyType;
        const location = req.query.location;
        const minPrice = req.query.minPrice ? parseInt(req.query.minPrice) : null;
        const maxPrice = req.query.maxPrice ? parseInt(req.query.maxPrice) : null;
        
        // اختيار العروض للتصدير
        let offersToExport = [...realEstateOffers];
        
        // تطبيق التصفية إذا كان مطلوبًا
        if (isFiltered) {
            console.log('🔍 تطبيق معايير التصفية:');
            if (offerType) {
                console.log(`- نوع العرض: ${offerType}`);
                offersToExport = offersToExport.filter(offer => offer["نوع العرض"] === offerType);
            }
            
            if (propertyType) {
                console.log(`- نوع العقار: ${propertyType}`);
                offersToExport = offersToExport.filter(offer => offer["نوع العقار"] === propertyType);
            }
            
            if (location) {
                console.log(`- الموقع: ${location}`);
                offersToExport = offersToExport.filter(offer => 
                    offer["الموقع"] && offer["الموقع"].includes(location)
                );
            }
            
            if (minPrice !== null) {
                console.log(`- السعر الأدنى: ${minPrice}`);
                offersToExport = offersToExport.filter(offer => {
                    if (offer["السعر"] === "غير محدد") return false;
                    const price = parseInt(offer["السعر"].replace(/[^\d]/g, ''));
                    return !isNaN(price) && price >= minPrice;
                });
            }
            
            if (maxPrice !== null) {
                console.log(`- السعر الأقصى: ${maxPrice}`);
                offersToExport = offersToExport.filter(offer => {
                    if (offer["السعر"] === "غير محدد") return false;
                    const price = parseInt(offer["السعر"].replace(/[^\d]/g, ''));
                    return !isNaN(price) && price <= maxPrice;
                });
            }
            
            console.log(`✅ تم تصفية العروض: ${offersToExport.length} عرض متطابق مع المعايير`);
        }
        
        // إذا لم تكن هناك عروض بعد التصفية
        if (offersToExport.length === 0) {
            return res.status(404).send('لا توجد عروض تطابق معايير التصفية');
        }
        
        console.log(`📊 تصدير ${offersToExport.length} عرض عقاري إلى إكسل`);
        
        // تحويل البيانات إلى تنسيق مناسب لـ Excel مع تفاصيل أكثر
        const formattedData = offersToExport.map(offer => ({
            "نوع العرض": offer["نوع العرض"] || "غير محدد",
            "نوع العقار": offer["نوع العقار"] || "غير محدد",
            "الموقع": offer["الموقع"] || "غير محدد",
            "المساحة": offer["المساحة"] || "غير محدد",
            "السعر": offer["السعر"] || "غير محدد",
            "عدد الغرف": offer["عدد الغرف"] || "غير محدد",
            "دورات المياه": offer["دورات المياه"] || "غير محدد",
            "رقم الهاتف": offer["رقم الهاتف"] || "غير متوفر",
            "المجموعة": offer["المجموعة"] || "غير محدد",
            "اسم المرسل": offer["المرسل"] || "غير محدد",
            "التاريخ": offer["التاريخ"] || "غير محدد",
            "معرف الرسالة": offer["معرف الرسالة"] || "غير محدد",
            "النص الكامل": offer["النص الكامل"] || "غير متوفر"
        }));
        
        // إنشاء ملف Excel
        const wb = xlsx.utils.book_new();
        
        // إنشاء ورقة عمل
        const ws = xlsx.utils.json_to_sheet(formattedData);
        
        // ضبط عرض الأعمدة
        const colWidths = [
            { wch: 15 },  // نوع العرض
            { wch: 15 },  // نوع العقار
            { wch: 20 },  // الموقع
            { wch: 15 },  // المساحة
            { wch: 15 },  // السعر
            { wch: 12 },  // عدد الغرف
            { wch: 12 },  // دورات المياه
            { wch: 15 },  // رقم الهاتف
            { wch: 25 },  // المجموعة
            { wch: 15 },  // اسم المرسل
            { wch: 20 },  // التاريخ
            { wch: 30 },  // معرف الرسالة
            { wch: 100 }  // النص الكامل
        ];
        
        ws['!cols'] = colWidths;
        
        // إضافة ورقة العمل إلى الدفتر
        xlsx.utils.book_append_sheet(wb, ws, "عروض العقارات");
        
        // تحديد اسم الملف
        const fileName = isFiltered ? 'عروض_عقارية_مصفاة.xlsx' : 'عروض_عقارية.xlsx';
        const filePath = path.join(downloadsFolder, fileName);
        
        // طباعة معلومات المسارات للتشخيص
        console.log(`📂 مسار مجلد التنزيلات: ${downloadsFolder}`);
        console.log(`📄 مسار ملف التصدير: ${filePath}`);
        
        try {
            // كتابة الملف
            xlsx.writeFile(wb, filePath);
            console.log(`✅ تم إنشاء ملف إكسل: ${filePath}`);
            
            // إرسال الملف للمستخدم
            res.download(filePath, fileName, (err) => {
                if (err) {
                    console.error('❌ خطأ في تنزيل الملف:', err);
                    res.status(500).send('حدث خطأ أثناء تنزيل الملف: ' + err.message);
                } else {
                    console.log(`📥 تم تنزيل الملف ${fileName} بنجاح`);
                }
            });
        } catch (writeError) {
            console.error('❌ خطأ في كتابة ملف إكسل:', writeError);
            res.status(500).send('حدث خطأ أثناء إنشاء ملف إكسل: ' + writeError.message);
        }
    } catch (error) {
        console.error('❌ خطأ في تصدير العروض:', error);
        res.status(500).send('حدث خطأ أثناء تصدير العروض: ' + error.message);
    }
});


// نقطة نهاية للتحقق من حالة رمز QR
app.get('/api/qr-status', (req, res) => {
    res.json({
        isConnected: serverStatus.isConnected,
        lastUpdated: serverStatus.lastUpdated
    });
});

// دالة لفحص محفوظات المجموعات - أضف هذه الدالة قبل استخدامها في نقطة النهاية
async function scanGroupsHistory(maxMessages = 200) {
    try {
        // الحصول على قائمة المجموعات
        const chats = await client.getChats();
        const groups = chats.filter(chat => chat.isGroup);
        
        console.log(`🔍 وجد ${groups.length} مجموعة للفحص`);
        let totalFound = 0;
        
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            try {
                console.log(`🔍 جاري فحص مجموعة (${i+1}/${groups.length}): ${group.name}`);
                io.emit('history_progress', { current: i+1, total: groups.length });
                
                // الحصول على رسائل المجموعة
                let messages = [];
                try {
                    messages = await group.fetchMessages({ limit: maxMessages });
                } catch (msgError) {
                    console.error(`⚠️ خطأ في جلب رسائل المجموعة ${group.name}:`, msgError.message);
                    continue; // الانتقال للمجموعة التالية
                }
                
                console.log(`📄 تم العثور على ${messages.length} رسالة في المجموعة ${group.name}`);
                
                for (const message of messages) {
                    if (message.body && containsRealEstateKeywords(message.body)) {
                        // تحليل الرسالة
                        const messageDate = new Date(message.timestamp * 1000);
                        const messageDay = messageDate.toLocaleDateString('ar-EG');
                        const sender = message.author ? message.author.split('@')[0] : (message.from ? message.from.split('@')[0] : 'غير معروف');
                        const timestamp = messageDate.toLocaleString('ar-EG');
                        
                        // فحص إذا كانت الرسالة تحتوي على روابط أو رسائل موجهة
                        const hasLinks = /https?:\/\/[^\s]+/g.test(message.body);
                        const isForwarded = message._data && message._data.isForwarded;
                        
                        // تجاهل الرسائل الموجهة
                        if (isForwarded) {
                            continue;
                        }
                        
                        // تحقق من وجود معرف للرسالة
                        if (!message.id || !message.id._serialized) {
                            console.warn('⚠️ رسالة بدون معرف، سيتم تجاهلها');
                            continue;
                        }
                        
                        // تحليل الرسالة العقارية
                        try {
                            const offer = analyzeRealEstateMessage(message.body, group.name, sender, timestamp, message.id._serialized);
                            
                            if (offer) {
                                // إضافة العرض لقائمة العروض العقارية
                                realEstateOffers.push(offer);
                                totalFound++;
                                
                                // طباعة معلومات العرض في السجل
                                console.log(`🏠 [${group.name}] عرض ${offer["نوع العرض"]} ${offer["نوع العقار"]} في ${offer["الموقع"]}`);
                                
                                // تحديث الإحصائيات بعد كل 10 عروض
                                if (totalFound % 10 === 0) {
                                    io.emit('message_stats', messageStats);
                                    
                                    // حفظ البيانات بعد كل 50 عرض
                                    if (totalFound % 50 === 0) {
                                        saveOffersToDatabase();
                                    }
                                }
                            }
                        } catch (analyzeError) {
                            console.error('❌ خطأ في تحليل الرسالة:', analyzeError.message);
                            continue; // الانتقال للرسالة التالية
                        }
                    }
                }
                
                // تحديث الإحصائيات بعد كل مجموعة
                io.emit('message_stats', messageStats);
                
            } catch (groupError) {
                console.error(`❌ خطأ في فحص مجموعة ${group.name}:`, groupError.message);
            }
            
            // تأخير بسيط بين المجموعات
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // حفظ البيانات بعد الانتهاء من جميع المجموعات
        saveOffersToDatabase();
        
        // تحديث الإحصائيات النهائية
        io.emit('message_stats', messageStats);
        
        return totalFound;
    } catch (error) {
        console.error('❌ خطأ في فحص المحفوظات:', error);
        throw error;
    }
}


// نقطة نهاية لإعادة توليد رمز QR
// نقطة نهاية لفحص محفوظات المجموعات
app.get('/api/scan-history', async (req, res) => {
    try {
        // التحقق من الاتصال أولاً
        if (!serverStatus.isConnected) {
            return res.status(400).json({
                success: false,
                error: 'يجب الاتصال بواتساب أولاً'
            });
        }
        
        // تحديد عدد الرسائل للفحص
        const maxMessages = parseInt(req.query.max) || 200;
        
        console.log(`🔍 بدء فحص محفوظات المجموعات (الحد الأقصى: ${maxMessages} رسالة لكل مجموعة)`);
        
        // استدعاء دالة فحص المحفوظات
        const totalFound = await scanGroupsHistory(maxMessages);
        
        // إرسال النتيجة
        res.json({
            success: true,
            count: totalFound,
            message: `تم العثور على ${totalFound} عرض عقاري من المحفوظات`,
            stats: messageStats
        });
    } catch (error) {
        console.error('❌ خطأ في فحص المحفوظات:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ أثناء فحص المحفوظات'
        });
    }
});

// صفحة تصدير العروض إلى إكسل
app.get('/export', (req, res) => {
    try {
        // التحقق من وجود عروض للتصدير
        if (realEstateOffers.length === 0) {
            return res.status(400).send('لا توجد عروض عقارية للتصدير');
        }
        
        console.log(`📊 بدء تصدير ${realEstateOffers.length} عرض عقاري إلى إكسل`);
        
        // تحقق مما إذا كان التصدير مصفى
        const isFiltered = req.query.filtered === 'true';
        
        // معايير التصفية
        const offerType = req.query.offerType;
        const propertyType = req.query.propertyType;
        const location = req.query.location;
        const minPrice = req.query.minPrice ? parseInt(req.query.minPrice) : null;
        const maxPrice = req.query.maxPrice ? parseInt(req.query.maxPrice) : null;
        
        // اختيار العروض للتصدير
        let offersToExport = [...realEstateOffers];
        
        // تطبيق التصفية إذا كان مطلوبًا
        if (isFiltered) {
            console.log('🔍 تطبيق معايير التصفية:');
            if (offerType) {
                console.log(`- نوع العرض: ${offerType}`);
                offersToExport = offersToExport.filter(offer => offer["نوع العرض"] === offerType);
            }
            
            if (propertyType) {
                console.log(`- نوع العقار: ${propertyType}`);
                offersToExport = offersToExport.filter(offer => offer["نوع العقار"] === propertyType);
            }
            
            if (location) {
                console.log(`- الموقع: ${location}`);
                offersToExport = offersToExport.filter(offer => 
                    offer["الموقع"] && offer["الموقع"].includes(location)
                );
            }
            
            if (minPrice !== null) {
                console.log(`- السعر الأدنى: ${minPrice}`);
                offersToExport = offersToExport.filter(offer => {
                    if (offer["السعر"] === "غير محدد") return false;
                    const price = parseInt(offer["السعر"].replace(/[^\d]/g, ''));
                    return !isNaN(price) && price >= minPrice;
                });
            }
            
            if (maxPrice !== null) {
                console.log(`- السعر الأقصى: ${maxPrice}`);
                offersToExport = offersToExport.filter(offer => {
                    if (offer["السعر"] === "غير محدد") return false;
                    const price = parseInt(offer["السعر"].replace(/[^\d]/g, ''));
                    return !isNaN(price) && price <= maxPrice;
                });
            }
            
            console.log(`✅ تم تصفية العروض: ${offersToExport.length} عرض متطابق مع المعايير`);
        }
        
        // إذا لم تكن هناك عروض بعد التصفية
        if (offersToExport.length === 0) {
            return res.status(404).send('لا توجد عروض تطابق معايير التصفية');
        }
        
        console.log(`📊 تصدير ${offersToExport.length} عرض عقاري إلى إكسل`);
        
        // تحويل البيانات إلى تنسيق مناسب لـ Excel
        const formattedData = offersToExport.map(offer => ({
            "نوع العرض": offer["نوع العرض"] || "غير محدد",
            "نوع العقار": offer["نوع العقار"] || "غير محدد",
            "الموقع": offer["الموقع"] || "غير محدد",
            "المساحة": offer["المساحة"] || "غير محدد",
            "السعر": offer["السعر"] || "غير محدد",
            "عدد الغرف": offer["عدد الغرف"] || "غير محدد",
            "دورات المياه": offer["دورات المياه"] || "غير محدد",
            "رقم الهاتف": offer["رقم الهاتف"] || "غير متوفر",
            "المجموعة": offer["المجموعة"] || "غير محدد",
            "التاريخ": offer["التاريخ"] || "غير محدد"
        }));
        
        // إنشاء ملف Excel
        const wb = xlsx.utils.book_new();
        
        // إنشاء ورقة عمل
        const ws = xlsx.utils.json_to_sheet(formattedData);
        
        // إضافة ورقة العمل إلى الدفتر
        xlsx.utils.book_append_sheet(wb, ws, "عروض العقارات");
        
        // التأكد من وجود مجلد التنزيلات
        if (!fs.existsSync(downloadsFolder)) {
            console.log(`🔧 إنشاء مجلد التنزيلات: ${downloadsFolder}`);
            fs.mkdirSync(downloadsFolder, { recursive: true });
        }
        
        // تحديد اسم الملف
        const fileName = isFiltered ? 'عروض_عقارية_مصفاة.xlsx' : 'عروض_عقارية.xlsx';
        const filePath = path.join(downloadsFolder, fileName);
        
        // طباعة معلومات المسارات للتشخيص
        console.log(`📂 مسار مجلد التنزيلات: ${downloadsFolder}`);
        console.log(`📄 مسار ملف التصدير: ${filePath}`);
        console.log(`🔍 هل مجلد التنزيلات موجود؟ ${fs.existsSync(downloadsFolder)}`);
        
        try {
            // كتابة الملف
            xlsx.writeFile(wb, filePath);
            console.log(`✅ تم إنشاء ملف إكسل: ${filePath}`);
            
            // التحقق من إنشاء الملف
            if (fs.existsSync(filePath)) {
                console.log(`✅ تم التحقق من وجود الملف: ${filePath}`);
                
                // إرسال الملف للمستخدم
                res.download(filePath, fileName, (err) => {
                    if (err) {
                        console.error('❌ خطأ في تنزيل الملف:', err);
                        res.status(500).send('حدث خطأ أثناء تنزيل الملف: ' + err.message);
                    } else {
                        console.log(`📥 تم تنزيل الملف ${fileName} بنجاح`);
                    }
                });
            } else {
                throw new Error('لم يتم إنشاء الملف بشكل صحيح');
            }
        } catch (writeError) {
            console.error('❌ خطأ في كتابة ملف إكسل:', writeError);
            res.status(500).send('حدث خطأ أثناء إنشاء ملف إكسل: ' + writeError.message);
        }
    } catch (error) {
        console.error('❌ خطأ في تصدير العروض:', error);
        res.status(500).send('حدث خطأ أثناء تصدير العروض: ' + error.message);
    }
});
// نقطة نهاية للتحقق من حالة الاتصال
app.get('/api/connection-status', (req, res) => {
    res.json({
        isConnected: serverStatus.isConnected,
        lastUpdated: serverStatus.lastUpdated,
        lastMessage: serverStatus.lastMessage,
        reconnectAttempts: serverStatus.reconnectAttempts
    });
});

// نقطة نهاية لإعادة تشغيل الجلسة
app.get('/api/restart-session', async (req, res) => {
    try {
        console.log('🔄 إعادة تشغيل الجلسة...');
        
        // إعادة تعيين عدد محاولات إعادة الاتصال
        serverStatus.reconnectAttempts = 0;
        
        // محاولة تسجيل الخروج أولاً إذا كان متصلاً
        if (serverStatus.isConnected) {
            try {
                await client.logout();
            } catch (error) {
                console.warn('⚠️ فشل تسجيل الخروج:', error.message);
            }
        }
        
        // إيقاف العميل
        try {
            await client.destroy();
        } catch (error) {
            console.warn('⚠️ فشل إيقاف العميل:', error.message);
        }
        
        // إيقاف مؤقت
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // إعادة تهيئة العميل
        client.initialize().catch(err => {
            console.error('❌ خطأ أثناء إعادة تهيئة العميل:', err);
            res.json({ success: false, error: err.message });
        });
        
        res.json({ success: true, message: 'تم إعادة تشغيل الجلسة بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في إعادة تشغيل الجلسة:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// نقطة نهاية للتحقق من وجود ملف التصدير
app.get('/check-export-file', (req, res) => {
    const fileName = req.query.filtered === 'true' ? 'عروض_عقارية_مصفاة.xlsx' : 'عروض_عقارية.xlsx';
    const filePath = path.join(downloadsFolder, fileName);
    
    if (fs.existsSync(filePath)) {
        res.json({ exists: true, path: `/downloads/${fileName}` });
    } else {
        res.json({ exists: false });
    }
});

server.listen(3000, () => {
    console.log('🚀 السيرفر يعمل على http://localhost:3000');

    console.log('⏱️ بدء تهيئة واتساب بعد ثانيتين...');
    setTimeout(() => {
        console.log('🔄 جاري تهيئة واتساب...');
        client.initialize().catch(err => {
            console.error('❌ خطأ أثناء تهيئة العميل:', err);
        });
    }, 2000); // تقليل وقت الانتظار من 5 ثوانٍ إلى ثانيتين
});