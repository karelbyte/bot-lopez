function singularize(word) {
    const lower = word.toLowerCase().trim()
    if (lower.length < 3) return lower
    const invariables = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'paraguas', 'sacapuntas', 'cumpleanos', 'virus', 'caos', 'torax']
    if (invariables.includes(lower)) return lower
    if (lower.endsWith('ces')) return lower.slice(0, -3) + 'z'
    if (lower.endsWith('es')) {
        const sinEs = lower.slice(0, -2)
        if (sinEs.length >= 2) return sinEs
    }
    if (lower.endsWith('s')) {
        const sinS = lower.slice(0, -1)
        if (sinS.length >= 2) return sinS
    }
    return lower
}

function expandTerms(text) {
    const words = text.trim().split(/\s+/).filter(w => w.length > 0)
    return words.map(word => {
        const variants = [word]
        const singular = singularize(word)
        if (singular !== word.toLowerCase()) {
            variants.push(singular)
        }
        if (word.toLowerCase().endsWith('es')) {
            const sinSoloS = word.slice(0, -1)
            if (sinSoloS.toLowerCase() !== singular && sinSoloS.length >= 2) {
                variants.push(sinSoloS)
            }
        }
        return variants
    })
}

const parasitePrefixes = [
    'estoy buscando', 'anda buscando', 'ando buscando', 'busco',
    'quiero', 'kiero', 'kero', 'uiro', 'hiero', 'iero', 'qiero',
    'necesito', 'nesecito', 'neseito', 'nececito',
    'ocupo', 'okupo', 'ocuppo',
    'requiero', 'requerir',
    'me cotiza', 'me cotizas', 'cotizame', 'cotice',
    'una cotizacion de', 'la cotizacion de',
    'precio de', 'precios de', 'pasame precio de', 'pasame precios de',
    'a cuanto', 'a como', 'cuanto cuesta', 'cuanto vale', 'cuanto sale',
    'informacion de', 'info de', 'info sobre', 'informacion sobre',
    'me das precio de', 'me da precio de', 'me pasas precio de',
    'me puedes cotizar', 'puedes cotizarme', 'podrias cotizarme',
    'me gustaria cotizar', 'me gustaria saber precio',
    'me interesa', 'estoy interesado en', 'estoy interesada en',
    'quisiera cotizar', 'quisiera saber', 'queria cotizar',
    'precio', 'cotizacion', 'cotización',
    'quiero cotizar',
    'por favor'
]

const parasiteWords = [
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'de', 'del', 'para', 'por', 'con', 'en', 'sin', 'sobre',
    'y', 'e', 'o', 'a', 'al', 'ante', 'bajo', 'cabe',
    'como', 'contra', 'desde', 'durante', 'entre',
    'hacia', 'hasta', 'mediante', 'para', 'segun',
    'segun', 'so', 'tras', 'versus', 'via',
    'lo', 'le', 'les', 'se', 'te',
    'que', 'cual', 'cuales', 'quien', 'quienes',
    'mas', 'menos', 'muy', 'mucho', 'poco',
    'este', 'esta', 'estos', 'estas',
    'ese', 'esa', 'esos', 'esas',
    'aquel', 'aquella', 'aquellos', 'aquellas',
    'mi', 'tu', 'su', 'mis', 'tus', 'sus',
    'es', 'son', 'era', 'sera', 'seria',
    'tengo', 'tienes', 'tenemos', 'tendrá', 'tendras', 'tendrían', 'tendrian', 'tendría', 'tendria',
    'dame', 'pasame', 'muestrame', 'enseñame',
    'ver', 'mira', 'mire', 'buscar', 'busquemos',
    'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches',
    'saludos', 'gracias', 'favor', 'please', 'plis',
    'comprar', 'compra', 'cotizar', 'cotizando',
    'saber', 'consultar', 'consulta', 'preguntar',
    'informacion', 'información', 'info',
    'chico', 'chica', 'amigo', 'amiga', 'disculpa', 'disculpe',
    'porfa', 'porfis', 'please',
    'me', 'te', 'le', 'les', 'nos',
    'das', 'da', 'dame', 'pasas', 'pasame',
    'pasa', 'puedes', 'puede', 'podrias', 'podria',
    'gustaria', 'gusta'
]

function removeAccents(text) {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function cleanSearchQuery(text) {
    let cleaned = text.trim()
    const lower = cleaned.toLowerCase()
    const noAccents = removeAccents(lower)
    
    // Eliminar prefijos parásitos (incluye versiones con y sin tilde)
    for (const prefix of parasitePrefixes) {
        const prefixNoAccents = removeAccents(prefix)
        // Probar tanto con tilde como sin tilde
        const regex1 = new RegExp('(?:^|[\\s,.;:!?]+)' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s.,;:!?\\-]*', 'i')
        const regex2 = new RegExp('(?:^|[\\s,.;:!?]+)' + prefixNoAccents.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s.,;:!?\\-]*', 'i')
        cleaned = cleaned.replace(regex1, ' ').replace(regex2, ' ')
    }
    
    cleaned = cleaned.replace(/[.,;:!?\-_]+/g, ' ')
    cleaned = cleaned.replace(/\s+/g, ' ')
    cleaned = cleaned.trim()
    
    const words = cleaned.split(/\s+/).filter(w => w.length > 0)
    const significant = words.filter(w => {
        const lowerW = w.toLowerCase()
        const lowerWNoAccents = removeAccents(lowerW)
        // Verificar tanto con tilde como sin tilde
        if (parasiteWords.includes(lowerW)) return false
        if (parasiteWords.includes(lowerWNoAccents)) return false
        if (lowerW.length < 2) return false
        return true
    })
    
    cleaned = significant.join(' ')
    return cleaned || text.trim()
}

module.exports = { singularize, expandTerms, cleanSearchQuery }

