/* ============================================================================
   Consilia — baked sample corpus
   --------------------------------------------------------------------------
   The live application loads output/consilia.json (built by src/build.py) and
   output/authors.json.  Those files are NOT committed to the repo (only the
   embedding metadata is), so this module supplies a small, realistic stand-in
   corpus of Latin consilia attributed to Baldo de Ubaldis, plus synthetic
   topical embeddings, so the full interface — reader, search, semantic map —
   is visible and interactive offline.  Drop the real JSON back in and the
   pages use it unchanged (see the loader in each page).
   ============================================================================ */

(function () {
  const VOL1 = 'Baldo_Cons_Print_Venice_1575_v1';
  const VOL4 = 'Baldo_Cons_Print_Venice_1575_v4';
  const VIAF = 'Baldo_29618397';

  // topical clusters used to synthesise semantic embeddings + the PCA map
  const CLUSTERS = [
    'Feuda & successio',
    'Dos & matrimonium',
    'Iudicia & processus',
    'Mercatura & cambium',
    'Crimen & poena',
    'Ius ecclesiasticum',
  ];

  // [n, cluster, title, summary, [body...], [pageStems], volume]
  const RAW = [
    [1, 0, 'De feudo paterno inter filios dividendo',
      'Quaeritur an feudum paternum inter plures filios aequis portionibus dividi debeat, an primogenito integrum cedat secundum consuetudinem Longobardam.',
      ['Casus talis est. Decessit Titius miles relictis tribus filiis legitimis et feudo quod a domino in beneficium tenuerat. Petunt filii minores ut feudum inter eos aequaliter partiatur; primogenitus vero totum sibi vindicat ratione consuetudinis et investiturae paternae.',
       'Et videtur quod feudum dividi debeat, quia successio in feudo naturam patrimonii sequitur, ut not. in l. si quis, ff. de legatis, et per consuetudinem feudorum filii in solidum succedunt nisi aliud actum sit in investitura. Praeterea odiosa est exclusio coheredum, et favorabilis divisio, ut C. communia utriusque iudicii.',
       'Sed contra praevalet consuetudo loci et tenor investiturae. Nam si dominus feudum uni et heredibus eius masculis contulit, intelligitur successio per ordinem primogeniturae, nec admittuntur ceteri nisi deficiente linea. Ita tenendum, salvis alimentis fratribus de fructibus feudi praestandis, prout aequitas suadet.',
       'Concludo igitur feudum primogenito integrum cedere ubi investitura ita sonat; secus, si pure et simpliciter filiis collatum est, tunc pro virili portione dividitur. Et ita consului ego Baldus, salvo semper saniori iudicio.'],
      ['0012', '0013'], VOL1],

    [2, 1, 'De dote restituenda mortua muliere sine liberis',
      'An mortua uxore sine prole superstes maritus dotem retineat, an integra ad heredes mulieris vel ad patrem constituentem revertatur.',
      ['Mulier nupta constituit dotem ex bonis paternis et decessit constante matrimonio nullis liberis relictis. Pater qui dotem dederat eam repetit; maritus vero ratione lucri dotalis et pactorum nuptialium retentionem sibi competere asserit.',
       'Dicendum quod dos profecticia patri revertitur mortua filia sine liberis, ut l. dotis fructum, ff. soluto matrimonio, et C. de iure dotium. Ratio est quia dos data est onera matrimonii sustinenda, quibus cessantibus cessat causa retentionis penes maritum.',
       'Maritus tamen lucratur id quod pactis dotalibus expresse sibi reservatum est, et fructus dotis temporis matrimonii suos facit. Quod si pacta sileant, nihil ultra impensas necessarias deducit. Haec est communis opinio doctorum quam sequendam censeo.'],
      ['0031'], VOL1],

    [3, 2, 'An testamentum ruptum agnatione postumi valeat',
      'De testamento quod per agnationem postumi rumpitur, et an institutio heredum in eo facta aliquem effectum retineat.',
      ['Testator condidit testamentum institutis duobus filiis, postea nascitur ei postumus de quo nihil cavit. Quaeritur an totum testamentum corruat, an in parte subsistat.',
       'Regula iuris est quod agnatione postumi sui rumpitur testamentum, ut Inst. de exheredatione liberorum, et l. postumus, ff. de iniusto rupto. Ruptum autem testamentum nullum producit effectum, neque institutio neque legata valent, et succeditur ab intestato.',
       'Nec obstat voluntas testatoris in ceteris manifesta, quia favore postumi et ne praeteritus laedatur, lex totum infirmat. Itaque heredes ab intestato cum postumo concurrunt pro portionibus legitimis. Sic respondeo.'],
      ['0044', '0045'], VOL1],

    [4, 2, 'De usuris ex mora debitoris',
      'Quaeritur an creditor post moram debitoris usuras petere possit ubi nulla de usuris conventio intercessit.',
      ['Mutuavit Sempronius centum aureos sine pacto de usuris; transacto termino debitor solvere distulit. Petit creditor usuras ratione morae.',
       'Communiter tenetur quod in mutuo pecuniae usurae non debentur nisi ex conventione, ut C. de usuris. Sed ex mora et ex officio iudicis usurae quae morae nomine veniunt taxari possunt ubi creditor damnum probat, secundum l. eum qui, ff. de usuris.',
       'Cavendum tamen ne usurae modum legitimum excedant, et ne sub colore morae usura palliata exigatur contra canones. Iudex igitur arbitrabitur interesse creditoris citra usurariam pravitatem.'],
      ['0058'], VOL1],

    [5, 5, 'De praescriptione longi temporis contra ecclesiam',
      'An bona ecclesiae praescriptione longi temporis a laico adquiri possint, et quod tempus ad eam requiratur.',
      ['Possidet laicus fundum ecclesiae per quadraginta annos bona fide et titulo. Ecclesia rem vindicat negans praescriptionem currere contra se.',
       'Dicendum quod res ecclesiae longiore tempore praescribuntur quam res privatorum, scilicet quadraginta annorum spatio, ut auth. quas actiones, et C. de praescriptione XXX vel XL annorum. Intra id tempus nulla praescriptio nocet ecclesiae.',
       'Requiritur insuper bona fides continua et titulus, deficiente quibus ne longissimum quidem tempus sufficit. Cum autem in casu nostro quadraginta anni cum titulo et bona fide concurrant, praescriptio admittitur et ecclesia excluditur.'],
      ['0071', '0072'], VOL1],

    [6, 2, 'De fideiussore qui post solutionem regressum petit',
      'De regressu fideiussoris adversus debitorem principalem post solutum debitum, et an cedi sibi actiones petere possit.',
      ['Fideiussor pro Titio solvit creditori totum debitum; quaerit deinde an a Titio integrum repetere et an beneficio cedendarum actionum uti possit.',
       'Constat fideiussorem qui solvit habere regressum adversus principalem ex mandato vel negotiorum gestione, ut ff. mandati et de fideiussoribus. Potest etiam, ante solutionem, exigere ut creditor sibi actiones cedat, quo facto in ius creditoris succedit.',
       'Si plures sint fideiussores, qui solvit pro parte ceteros conventire potest beneficio divisionis, dummodo solvendo sint. Haec iuris communis sunt et apud omnes recepta.'],
      ['0089'], VOL1],

    [7, 2, 'De servitute itineris per fundum vicini',
      'An servitus itineris constituatur per longam consuetudinem, ubi nullum appareat constitutionis instrumentum.',
      ['Dominus fundi dominantis per fundum vicini iter facit ex immemorabili tempore; vicinus subito prohibet asserens nullam servitutem deberi.',
       'Servitutes praediorum rusticorum, ut iter actus via, vel titulo vel longa quasi possessione adquiruntur, ut ff. de servitutibus praediorum rusticorum. Vetustas cuius memoria non extat pro titulo et privilegio habetur.',
       'Cum igitur usus itineris immemorabilis probetur testibus fide dignis, servitus praesumitur legitime constituta, nec vicinus eam impedire potest. Confirmatur quia in dubio favendum est libertati itineris diu usitati.'],
      ['0103'], VOL1],

    [8, 0, 'De legato sub condicione relicto',
      'Quaeritur an legatum sub condicione relictum, pendente condicione mortuo legatario, ad eius heredes transmittatur.',
      ['Testator legavit Gaio centum si navis ex Asia venerit; Gaius vivente testatore et pendente condicione decessit. Petunt heredes Gaii legatum impleta postea condicione.',
       'Distinguendum est. In condicione casuali, si legatarius pendente condicione moritur, legatum non transmittitur ad heredes, quia dies nondum cesserat, ut ff. de condicionibus et demonstrationibus. Aliter in condicione iam impleta vivente legatario.',
       'Quod si condicio sit in potestate legatarii et per eum non steterit quominus impleretur, favorabilius transmissio admittitur. In casu autem proposito, condicione casuali existente, heredes excluduntur.'],
      ['0118', '0119'], VOL1],

    [9, 3, 'De emptione rei alienae bona fide',
      'An emptor rei alienae bona fide possit usucapere, et quid iuris si vera dominus rem vindicet.',
      ['Emit Titius fundum a Sempronio qui dominus non erat, ignorans rem alienam; possidet triennio. Supervenit verus dominus et rem vindicat.',
       'Emptio rei alienae valida est inter contrahentes, licet dominium non transferat, ut ff. de contrahenda emptione. Emptor bona fide et iusto titulo possidens usucapit rem mobilem triennio, immobilem longi temporis spatio, ut C. de usucapione.',
       'Si autem verus dominus ante completam usucapionem vindicet, emptor rem restituit sed adversus venditorem actione empti et de evictione regreditur ad id quod interest. Ita consulendum.'],
      ['0127'], VOL1],

    [10, 4, 'De crimine falsi in instrumento publico',
      'De poena notarii qui instrumentum falsum confecit, et an fides instrumenti suspecti penitus tollatur.',
      ['Notarius publicus confecit instrumentum in quo dies et summa dolose mutavit in praeiudicium tertii. Detecta re, agitur de poena et de fide instrumenti.',
       'Crimen falsi committit qui veritatem in instrumento publico dolo mutat, ut ff. ad legem Corneliam de falsis. Notarius falsarius poena falsi tenetur, et instrumentum falsum nullam fidem facit, immo pro non scripto habetur.',
       'Pars tamen quae falsum allegat onus probandi sustinet; donec probetur, instrumentum publicum sua fide gaudet ex auctoritate officii. Probato vero falso, et instrumentum corruit et notarius infamia ac poena plectitur.'],
      ['0141', '0142'], VOL1],

    [11, 1, 'De alimentis filio naturali debitis',
      'An pater alimenta filio naturali praestare teneatur, et an filius naturalis ad successionem aliquam admittatur.',
      ['Filius naturalis ex soluta susceptus alimenta a patre divite petit, quae pater denegat asserens nullum sibi vinculum legitimum esse.',
       'Pater tenetur ex pietate et iure naturali filium etiam naturalem alere, ut auth. de naturalibus liberis, et C. de alimentis. Alimenta enim a iure naturali descendunt nec legitimitatem requirunt.',
       'Ad successionem vero filius naturalis non admittitur cum legitimis, sed alimentorum nomine et modicae portionis iure contentus est, nisi per subsequens matrimonium legitimetur. Sic distinguendum et respondendum.'],
      ['0155'], VOL1],

    [12, 1, 'De pactis dotalibus inter coniuges',
      'De validitate pactorum quibus coniuges lucrum dotis et augmenti inter se constituunt, et an contra ius commune valeant.',
      ['Coniuges in contractu nuptiali paciscuntur ut superstes lucretur dimidiam dotis et augmenti partem. Quaeritur an huiusmodi pacta serventur.',
       'Pacta dotalia quae bonis moribus non adversantur servanda sunt, ut C. de pactis conventis, et favore matrimonii lata interpretatione recipiuntur. Lucrum dotis ex pacto licite constituitur dummodo modum statuti non excedat.',
       'Si tamen pactum in fraudem statuti vel liberorum tendat, eatenus non valet quatenus laedit. Servabitur igitur pactum intra fines aequitatis et statutorum loci.'],
      ['0168', '0169'], VOL1],

    [13, 0, 'De successione ab intestato fratrum',
      'Quo ordine fratres et eorum liberi ab intestato succedant, et an nepos ex fratre cum patruo concurrat.',
      ['Defunctus est sine liberis et parentibus, superstitibus uno fratre et nepote ex altero fratre praemortuo. Quaeritur de modo succedendi.',
       'In successione ab intestato fratres germani primo loco vocantur in capita; liberi fratris praemortui in stirpes succedunt iure repraesentationis, ut auth. post fratres, et Inst. de legitima agnatorum successione.',
       'Itaque frater superstes mediam, nepos ex fratre alteram mediam in stirpem accipit. Repraesentatio enim in hac linea usque ad fratrum filios admittitur, ulterius non procedit.'],
      ['0181'], VOL1],

    [14, 2, 'De iurisdictione iudicis delegati',
      'An iudex delegatus extra terminos mandati procedens valide iudicet, et an a sententia eius appelletur ad delegantem.',
      ['Iudex a principe delegatus ad certam causam, ea finita, in aliam connexam procedit. Pars gravata de excessu mandati et de appellatione quaerit.',
       'Iudex delegatus nonnisi intra terminos delegationis iurisdictionem habet; ultra procedens nullius momenti gerit, ut ff. de iurisdictione, et de officio eius cui mandata est iurisdictio. Quae extra mandatum aguntur ipso iure nulla sunt.',
       'A sententia delegati appellatur ad delegantem, non ad ordinarium, quia iurisdictio a mandante derivatur. Excessus tamen mandati non per appellationem sed per nullitatis querelam retractatur.'],
      ['0195', '0196'], VOL1],

    /* ── second print (v4) — for the volume selector & cross-print scope ── */
    [37, 3, 'De cambio et mercatorum consuetudine',
      'An contractus cambii usuram contineat, et quatenus consuetudo mercatorum in eo servanda sit.',
      ['Mercator Florentinus tradit Venetiis pecuniam recipiendam alibi diversa moneta cum lucro temporis et loci. Dubitatur an talis contractus usurarius sit.',
       'Cambium per litteras, ubi vera fit permutatio monetae loco distantis, licitum est nec usuram sapit, quia pretium periculi et distantiae loci, non temporis, attenditur. Consuetudo mercatorum ut altera lex in his servatur, ut ff. de rebus creditis.',
       'Si tamen sub specie cambii nullo loci intervallo merum lucrum temporis quaeratur, cambium siccum est et usuram palliat, ideoque reprobatur. Distinctio haec apud mercatores et doctores recepta est.'],
      ['0024', '0025'], VOL4],

    [38, 3, 'De arbitrio boni viri in societate',
      'De divisione lucri et damni in societate ubi pars boni viri arbitrio relicta est.',
      ['Inita societate convenerunt socii ut lucri portio arbitrio boni viri statueretur; orta lite quaeritur an tale arbitrium valeat.',
       'Societas in qua lucrum et damnum arbitrio boni viri committitur valida est, ut ff. pro socio; reprobatur autem leonina societas qua unus totum lucrum, alter totum damnum ferret.',
       'Arbitrium boni viri ad aequitatem reducitur, et si manifeste iniquum sit, iudicis officio corrigitur. Servata proportione laborum et capitis, lucrum dividitur.'],
      ['0040'], VOL4],

    [39, 4, 'De testibus in causa criminali',
      'Quot et quales testes ad condemnationem in criminalibus requirantur, et an unus testis sufficiat.',
      ['In causa capitali producitur unus testis omni exceptione maior. Quaeritur an eius dicto reus condemnari possit.',
       'In criminalibus ad condemnationem plena probatio requiritur, quae unius testis dicto non perficitur, ut C. de testibus: unus testis nullus testis. Duobus saltem testibus idoneis et contestibus opus est.',
       'Unus tamen testis cum aliis adminiculis ad torturam vel ad indicia movere potest, non ad plenam condemnationem. In dubio reus absolvendus est, favore vitae et libertatis.'],
      ['0056', '0057'], VOL4],

    [40, 5, 'De decimis ecclesiae solvendis',
      'An decimae de novalibus et de fructibus industriae ecclesiae debeantur, et de praescriptione contra decimas.',
      ['Colonus novalia excolens decimas solvere recusat asserens consuetudinem non solvendi. Ecclesia decimas integras petit.',
       'Decimae iure divino et canonico ecclesiae debentur de omnibus fructibus, etiam de novalibus, ut extra de decimis. Consuetudo non solvendi reprobata est nisi titulo et praescriptione legitima fulciatur.',
       'Praescriptio contra decimas personales non nisi quadraginta annorum et titulo apostolico admittitur. Deficiente titulo, colonus ad solutionem decimarum cogitur.'],
      ['0073'], VOL4],
  ];

  const CONSILIA = {};
  RAW.forEach(([n, cl, title, summary, body, pages, vol]) => {
    const id = `consilium-${vol.toLowerCase()}-${n}`;
    CONSILIA[id] = {
      id, n, volume: vol, author_viaf: VIAF,
      cluster: cl,
      title, summary, body,
      sources: pages.map(p => ({ page: p + '.xml' })),
    };
  });

  const AUTHORS = {
    Baldo_29618397: {
      viaf: '29618397',
      name: 'Baldo de Ubaldis',
      dates: '1327–1400',
      prints: [VOL1, VOL4],
    },
  };

  /* ── synthetic topical embeddings (deterministic) ────────────────────────
     Real app uses BGE-M3 1024-d vectors.  Here we build small normalised
     vectors clustered by topic so semantic search, "find similar", and the
     PCA map all behave plausibly with no model download. */
  const DIM = 24;
  function seeded(i) { let s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); }
  const clusterCenters = CLUSTERS.map((_, k) => {
    const v = new Array(DIM).fill(0);
    for (let d = 0; d < DIM; d++) v[d] = seeded(k * 100 + d) - 0.5;
    return v;
  });
  function buildVectors() {
    const vecs = {};
    Object.values(CONSILIA).forEach((c, ci) => {
      const base = clusterCenters[c.cluster];
      const v = new Array(DIM);
      let norm = 0;
      for (let d = 0; d < DIM; d++) {
        v[d] = base[d] * 1.0 + (seeded(c.n * 31 + d * 7) - 0.5) * 0.35;
        norm += v[d] * v[d];
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < DIM; d++) v[d] /= norm;
      vecs[c.id] = v;
    });
    return vecs;
  }

  window.CONSILIA_DATA = { consilia: CONSILIA };
  window.AUTHORS_DATA  = AUTHORS;
  window.SEM_CLUSTERS  = CLUSTERS;
  window.SEM_DIM       = DIM;
  window.buildDemoVectors = buildVectors;
  window.demoClusterCenters = clusterCenters;
})();
