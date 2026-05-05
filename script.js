// Firebase configuration (tbs-app-e2062)
const firebaseConfig = {
    apiKey: 'AIzaSyANhRZZnQ9tXH-DmO8QQT-H-64LOaa0oAU',
    authDomain: 'tbs-app-e2062.firebaseapp.com',
    projectId: 'tbs-app-e2062',
    storageBucket: 'tbs-app-e2062.firebasestorage.app',
    messagingSenderId: '696221319423',
    appId: '1:696221319423:web:805b69b93e93d206568cca',
    measurementId: 'G-HH4D0B5F2D'
};

let firestoreDb = null;
const FIRESTORE_HOME_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const firestoreHomeCache = {
    programmeDayByIsoDate: new Map(), // isoDate -> { value, fetchedAt, promise } — tbs/Programme/{isoDate}/Programme.html (home day cards)
    speakersByEventId: new Map(), // eventId -> { value, fetchedAt, promise }
    speakerInfoByEventId: new Map(), // eventId -> { value, fetchedAt, promise } — events/{id} field speakerinfo (first card bio HTML)
    locationInfoByEventId: new Map(), // eventId -> { value, fetchedAt, promise } — events/{id} field locationinfo (home Location band body)
    eventInfoByEventId: new Map(), // eventId -> { value, fetchedAt, promise } — tbs/Snippets field Eventinfo (home .event-contents)
    registrationManifesto: { value: '', fetchedAt: 0, promise: null },
    /** First programme-band card: `tbs/Snippets` field `Programmeinfo`. */
    programmeBandIntroSnippets: { value: '', fetchedAt: 0, promise: null }
};

function isFreshFirestoreCacheEntry(entry) {
    return !!entry && (Date.now() - Number(entry.fetchedAt || 0) < FIRESTORE_HOME_CACHE_TTL_MS);
}

function getFirestore() {
    if (typeof firebase === 'undefined') {
        throw new Error('Firebase SDK not loaded. Check that the Firebase script tags load before script.js.');
    }
    if (!firestoreDb) {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        // Default database: content lives under collection path `tbs/Content/...` (not a named DB id).
        firestoreDb = firebase.firestore();
    }
    return firestoreDb;
}

/** Reject if a Promise does not settle in time (Firestore and fetch can hang without a deadline). */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise(function (_, reject) {
            setTimeout(function () {
                reject(new Error(label || 'timeout'));
            }, ms);
        }),
    ]);
}

// Past talks post model (loaded from Firestore content feed)
let blogPosts = [];
let allPosts = [];

// DOM Elements
let blogGrid = document.getElementById('blogGrid');
let filterBtns = document.querySelectorAll('.filter-btn');
let loadMoreBtn = document.getElementById('loadMoreBtn');
const hamburger = document.querySelector('.hamburger');
const navMenu = document.querySelector('.nav-menu');
const newsletterForm = document.querySelector('.newsletter-form');

/** Sync active state for all `.nav-link[data-view="…"]` (e.g. header tabs). */
function setActiveNavView(view) {
    document.querySelectorAll('.nav-link').forEach((link) => link.classList.remove('active'));
    document.querySelectorAll('.nav-link[data-view="' + view + '"]').forEach((link) => {
        link.classList.add('active');
    });
}

/**
 * Clone/replace every nav control for a view so listeners stack cleanly (all matching links).
 * @param {string} view data-view value
 * @param {(e: Event) => void} onClick
 */
function bindViewLinks(view, onClick) {
    document.querySelectorAll('.nav-link[data-view="' + view + '"]').forEach((link) => {
        const fresh = link.cloneNode(true);
        link.parentNode.replaceChild(fresh, link);
        fresh.addEventListener('click', onClick);
    });
}

// State
let currentFilter = 'all';
let currentTopicFilter = 'all';
let searchQuery = '';
let postsToShow = 4;

/** Past talks: load N full rows of cards per batch (grid columns × this). */
const PAST_TALKS_ROWS_PER_BATCH = 4;

/** Column count for #blogGrid (matches CSS grid-template-columns / minmax(350px)). */
function getPastTalksBlogGridColumnCount() {
    const grid = document.getElementById('blogGrid');
    if (!grid || !grid.isConnected) return 1;
    const raw = (window.getComputedStyle(grid).gridTemplateColumns || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean).filter((p) => p !== 'none');
    if (parts.length >= 1) {
        return Math.max(1, parts.length);
    }
    const w = grid.clientWidth;
    if (!(w > 0)) return 1;
    const gap = 16;
    const minCol = 350;
    return Math.max(1, Math.floor((w + gap) / (minCol + gap)));
}

function getPastTalksPostsPerBatch() {
    return Math.max(1, getPastTalksBlogGridColumnCount() * PAST_TALKS_ROWS_PER_BATCH);
}

/** Inline SVG chevrons for feed / Past talks buttons (avoids Font Awesome webfont gaps in Safari). */
const UI_CHEVRON_DOWN_SVG =
    '<svg class="ui-chevron ui-chevron--down" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';
const UI_CHEVRON_UP_SVG =
    '<svg class="ui-chevron ui-chevron--up" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6 1.41 1.41z"/></svg>';

function resetPastTalksPagination() {
    postsToShow = getPastTalksPostsPerBatch();
}

// Treat Edit type like Video (home, past talks, video viewer)
function isVideoOrEditType(type) {
    const t = (type || '').toString().toLowerCase().trim();
    return t === 'video' || t === 'edit';
}

/** Single-select Type value (string or one-element array) → lowercase token */
function normalizePostTypeValue(val) {
    if (val == null || val === '') return '';
    const raw = Array.isArray(val) ? val[0] : val;
    return (raw != null ? String(raw) : '').toLowerCase().trim();
}

// Load Past talks posts from Firebase feed source - deferred execution
async function loadPostsFromFirebase() {
    try {
        showLoadingState();
        
        // Reuse the same Firestore-backed source as the home feed.
        const allRecords = await fetchNewsFeed();
        
        if (!allRecords || allRecords.length === 0) {
            console.error('No records received from Firebase feed source');
            showErrorState('No data available');
            return;
        }
        
        // Get all records and filter for Video and Edit types (Edit handled like Video)
        const videoRecords = allRecords.filter(record => 
            record.fields.Type && isVideoOrEditType(record.fields.Type)
        );
        
        // Transform video records to blog posts
        blogPosts = videoRecords.map(record => {
            // Handle image fields (string URL, attachment array/object)
            let imageUrl = '📝';
            if (record.fields.Image) {
                if (typeof record.fields.Image === 'string') {
                    imageUrl = record.fields.Image;
                } else if (Array.isArray(record.fields.Image) && record.fields.Image.length > 0) {
                    // Attachment array: use the first URL.
                    imageUrl = record.fields.Image[0].url;
                } else if (record.fields.Image && record.fields.Image.url) {
                    // Single attachment object
                    imageUrl = record.fields.Image.url;
                }
            }
            
            const post = {
                id: record.id,
                title: record.fields.Title || 'Untitled',
                name: record.fields.Name || null, // Add Name field
                excerpt: record.fields.Excerpt || 'No excerpt available',
                content: record.fields.Content || record.fields['Post Content'] || '',
                category: normalizeEventField(record.fields.Event || record.fields.Events),
                type: record.fields.Type || null,
                topic: record.fields.Topic || getSampleTopic(),
                date: record.fields.Date || new Date().toISOString().split('T')[0],
                readTime: record.fields['Read Time'] || '5 min',
                likes: record.fields.Likes || 0,
                comments: record.fields.Comments || 0,
                image: imageUrl,
                slug: record.fields.Slug || generateSlug(record.fields.Title || 'untitled'),
                featured: record.fields.Featured || false,
                youtubeUrl: record.fields.Youtube || null,
                fieldColour: record.fields.Fieldcolour || null
            };
            
            return post;
        });
        
        allPosts = [...blogPosts];
        
        // Sort posts by date (latest to earliest)
        allPosts.sort((a, b) => new Date(b.date) - new Date(a.date));

        prefetchBlogPostThumbnailsIntoCache(allPosts);
        
        // Populate filters after posts are loaded
        populateFilters();
        
        // Only render posts if we're in blog view (blogGrid exists)
        if (blogGrid) {
            resetPastTalksPagination();
            renderPosts();
            // Setup event listeners for the initial page load
            setupEventListeners();
            setupTopicButtonListeners();
        }
        
    } catch (error) {
        console.error('Error loading posts from Firebase:', error);
        
        // Redirect to feed when content source is unavailable
        void showFeedContent().then(() => scrollHomeToTop());
    }
}

// Generate URL slug from title
function generateSlug(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);
}

// Extract YouTube video ID from URL
function extractYouTubeId(url) {
    if (!url) return null;
    
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /youtube\.com\/watch\?.*v=([^&\n?#]+)/
    ];
    
    for (let pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}


/**
 * Start loading unique post thumbnail URLs into the browser image cache as soon as
 * `allPosts` exists (Past talks / #blogGrid may not be mounted yet on first paint).
 */
function prefetchBlogPostThumbnailsIntoCache(posts) {
    if (!posts || !posts.length) return;
    // Avoid competing with first paint/network: keep warmup tiny and best-effort.
    const maxPrefetch = 8;
    const canPrefetchAggressively =
        typeof navigator === 'undefined' ||
        !navigator.connection ||
        (navigator.connection.saveData !== true &&
            !/2g/.test(String(navigator.connection.effectiveType || '')));
    if (!canPrefetchAggressively) return;
    const seen = new Set();
    for (let i = 0; i < posts.length; i++) {
        if (seen.size >= maxPrefetch) break;
        const post = posts[i];
        if (!post) continue;
        const u = post.image;
        if (typeof u !== 'string') continue;
        const t = u.trim();
        if (!t || t === '📝') continue;
        if (!t.startsWith('http') && !t.startsWith('data:')) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        try {
            const img = new Image();
            img.decoding = 'async';
            img.referrerPolicy = 'no-referrer';
            img.src = t;
        } catch (_e) {
            /* ignore */
        }
    }
}

function scheduleBackgroundPastTalksWarmup() {
    const run = () => {
        // Warm up data for Past talks without delaying initial home interactivity.
        void loadPostsFromFirebase();
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2500 });
        return;
    }
    setTimeout(run, 400);
}

// Show loading state
function showLoadingState() {
    if (blogGrid) {
        blogGrid.innerHTML = '<div class="loading">Loading posts...</div>';
    }
}

// Show error state
function showErrorState(message) {
    if (blogGrid) {
        blogGrid.innerHTML = `<div class="error">${message}</div>`;
    } else {
        console.error('Error:', message);
    }
}

// Render blog posts
function renderPosts() {
    if (!blogGrid) return;

    let filteredPosts = allPosts;
    
    // Filter by event
    if (currentFilter !== 'all') {
        filteredPosts = filteredPosts.filter(post => post.category === currentFilter);
    }
    
    // Filter by topic
    if (currentTopicFilter !== 'all') {
        filteredPosts = filteredPosts.filter(post => {
            if (!post.topic) return false;
            
            // Handle both single topic (string) and multiple topics (array)
            if (Array.isArray(post.topic)) {
                // Multiple topics - check if any topic matches
                return post.topic.includes(currentTopicFilter);
            } else {
                // Single topic
                return post.topic === currentTopicFilter;
            }
        });
    }
    
    // Filter by search (all video fields: title, name, excerpt, content, category, topic)
    if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        filteredPosts = filteredPosts.filter(post => {
            const topicStr = Array.isArray(post.topic) ? (post.topic || []).join(' ') : (post.topic || '');
            const searchable = [
                post.title || '',
                post.name || '',
                post.excerpt || '',
                post.content || '',
                post.category || '',
                topicStr
            ].join(' ').toLowerCase();
            return searchable.includes(q);
        });
    }
    
    const postsToRender = filteredPosts.slice(0, postsToShow);
    
    blogGrid.innerHTML = '';
    
    if (postsToRender.length === 0) {
        blogGrid.innerHTML = '<p class="no-posts">No posts found.</p>';
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        return;
    }
    
    postsToRender.forEach((post) => {
        blogGrid.appendChild(createPostElement(post));
    });
    
    // Show/hide load more button
    if (loadMoreBtn) {
        loadMoreBtn.style.display = filteredPosts.length > postsToShow ? 'inline-flex' : 'none';
    }
}

// Create individual post element
function createPostElement(post) {
    const postDiv = document.createElement('div');
    postDiv.className = 'blog-card';
    postDiv.setAttribute('data-post-id', post.id);
    
    // Apply background color from Fieldcolour field if it exists
    if (post.fieldColour) {
        // Map color names to CSS color values
        const colorMap = {
            'Pink': '#fce7f3',
            'Yellow': '#fef3c7', 
            'Blue': '#F0FFFF'
        };
        const cssColor = colorMap[post.fieldColour] || post.fieldColour;
        postDiv.style.backgroundColor = cssColor;
        // Apply gray border like featured content when Fieldcolour is applied
        postDiv.style.border = '1px solid #e2e8f0';
    }
    
    // Check if image is a URL or emoji
    const isImageUrl = post.image && typeof post.image === 'string' && (post.image.startsWith('http') || post.image.startsWith('data:'));
    const imageContent = isImageUrl
        ? `<img src="${post.image}" alt="${post.title}" class="blog-card-thumbnail" loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer">`
        : `<div class="blog-card-emoji">${post.image || '📝'}</div>`;
    
    const postTypeKey = normalizePostTypeValue(post.type);
    const editTypeBadgeHtml =
        postTypeKey === 'edit' ? '<span class="news-card-new-badge">EDIT</span>' : '';

    const topicBadgeTopics = (() => {
        const t = post.topic;
        if (!t) return [];
        const isTypeLike = (label) => {
            const k = label.toLowerCase();
            return k === 'general' || k === 'video' || k === 'edit';
        };
        if (Array.isArray(t)) {
            return t
                .map((x) => (x != null ? String(x).trim() : ''))
                .filter(Boolean)
                .filter((x) => !isTypeLike(x));
        }
        const s = String(t).trim();
        if (!s || isTypeLike(s)) return [];
        return [s];
    })();
    const topicSpansHtml = topicBadgeTopics
        .map((label) => `<span class="news-card-category">${label}</span>`)
        .join('');
    const metaBadgesHtml =
        editTypeBadgeHtml || topicSpansHtml
            ? `<div class="news-card-badges" style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:flex-end;align-items:center;">${editTypeBadgeHtml}${topicSpansHtml}</div>`
            : '';

    postDiv.innerHTML = `
        <div class="blog-card-image">
            ${imageContent}
        </div>
        <div class="blog-card-content">
            <div class="blog-card-meta" style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem;">
                <p class="blog-card-date">${formatDate(post.date)}</p>
                ${metaBadgesHtml}
            </div>
            <h3 class="blog-card-title">${post.title}</h3>
            ${post.name ? `<p class="blog-card-name">${post.name}</p>` : ''}
            <p class="blog-card-excerpt">${post.excerpt}</p>
        </div>
    `;
    
    return postDiv;
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

// Setup event listeners
function setupEventListeners() {
    
    // Event filter buttons
    filterBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // Remove active class from all event buttons
            filterBtns.forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            this.classList.add('active');
            
            // Update current filter and reset posts to show
            currentFilter = this.dataset.category;
            resetPastTalksPagination();

            // Re-render posts
            renderPosts();
        });
    });
    
    // Topic filter buttons are now handled by setupTopicButtonListeners()
    
    // Load more button
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', function() {
            postsToShow += getPastTalksPostsPerBatch();
            renderPosts();
        });
    }
    
    // Blog card clicks
    if (blogGrid) {
    blogGrid.addEventListener('click', function(e) {
            // Find the closest blog card
            const blogCard = e.target.closest('.blog-card');
            if (blogCard) {
            e.preventDefault();
                e.stopPropagation();
                const postId = blogCard.dataset.postId;
            showPostModal(postId);
        }
    });
    }
}

// Setup topic button event listeners
function setupTopicButtonListeners() {
    const topicBtns = document.querySelectorAll('.topic-btn');
    
    topicBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // Remove active class from all topic buttons
            topicBtns.forEach(b => b.classList.remove('active'));
            // Add active class to clicked button
            this.classList.add('active');
            
            // Update current topic filter and reset posts to show
            currentTopicFilter = this.dataset.topic;
            resetPastTalksPagination();

            // Re-render posts
            renderPosts();
        });
    });
}

// Navigate to individual post page
function showPostModal(postId) {
    const post = allPosts.find(p => p.id == postId);
    if (post) {
        // Show post content on the same page
        showPostOnSamePage(post);
    }
}

// Global function to go back to feed (can be called from HTML onclick)
async function goBackToFeed() {
    try {
        await showFeedContent();
        scrollHomeToTop();
        setTimeout(() => {
            monitorFeaturedTitleBreak();
        }, 100);
    } catch (error) {
        console.error('Error going back to feed:', error);
    }
}

// Show post content on the same page
function showPostOnSamePage(post, fromFeed = false) {
    document.body.classList.add('home-view');
    setPastTalksOpenState(true);
    setActiveNavView('past-talks');
    const mainRoot = document.querySelector('.everything');
    const pastTalksSection = mainRoot ? mainRoot.querySelector(':scope > .past-talks-section') : null;
    if (pastTalksSection) {
        pastTalksSection.classList.add('is-collapsed');
        pastTalksSection.hidden = true;
        pastTalksSection.setAttribute('aria-hidden', 'true');
    }
    
    // Generate YouTube embed if URL exists
    let youtubeEmbed = '';
    if (post.youtubeUrl) {
        const videoId = extractYouTubeId(post.youtubeUrl);
        if (videoId) {
            youtubeEmbed = `
                <div class="post-video">
                    <div class="video-container">
                        <iframe src="https://www.youtube.com/embed/${videoId}" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                </div>
            `;
        }
    }
    
    // Use content as-is (it can contain HTML)
    const formattedContent = post.content || '';
    
    // Create back link based on source
    const backLinkText = fromFeed ? 'Back to home' : 'Back to talks';
    const backLinkFunction = fromFeed ? 'goBackToFeed()' : 'showBlogFeed()';

    const viewerPostTypeKey = normalizePostTypeValue(post.type);
    const viewerEditBadgeHtml =
        viewerPostTypeKey === 'edit' ? '<span class="news-card-new-badge">EDIT</span>' : '';

    // Create viewer section HTML (inserted into existing .everything container)
    const viewerInnerHTML = `
            <div class="viewer-section-inner-wrapper">
            <div class="top-links-container">
                <h3><a href="javascript:void(0)" onclick="${backLinkFunction}" class="back-to-blog">
                    <i class="fas fa-arrow-left"></i>${backLinkText}
                </a></h3>
            </div>
            <div class="video-layout">
                <div class="viewing">
                    <div class="viewing-main-col">
            ${youtubeEmbed}
            <div class="post-header">
                <div class="post-meta">
                    <span class="post-date">${formatDate(post.date)}</span>
                    <div class="post-meta-right">
                        ${viewerEditBadgeHtml}<span class="post-category">${post.category}</span>
                    </div>
                </div>
                <div class="speaker-container">
                    <h3 class="post-title">${post.title}</h3>
                    ${post.name ? `<p class="post-name">${post.name}</p>` : ''}
                </div>
            </div>
            ${formattedContent ? `<div class="post-content" style="padding-top: 16px; padding-bottom: 24px;">${formattedContent}</div>` : '<div class="post-content" style="padding-top: 16px; padding-bottom: 24px;"><p>No content available for this post.</p></div>'}
                    <a href="https://www.youtube.com/@TBSZermatt" target="_blank" rel="noopener" class="youtubereminder" style="background-color: #BFF0FF !important; text-decoration: none;"><span class="youtubereminder-text">Find all recorded content from TBS on our Youtube channel.</span><span class="youtubereminder-icon" aria-hidden="true"><i class="fab fa-youtube"></i></span></a>
                    </div>
                </div>
                <div class="morevideos">
                    <div class="morevideos-cards" id="morevideosCards">
                        <!-- Cards will be populated here -->
                    </div>
                </div>
            </div>
            <div class="bottom-links-container">
                <h3><a href="javascript:void(0)" onclick="${backLinkFunction}" class="back-to-blog">
                    <i class="fas fa-arrow-left"></i>${backLinkText}
                </a></h3>
            </div>
            </div>
    `;
    
    const main = document.querySelector('.everything');
    if (main) {
        const pastTalksSection = main.querySelector(':scope > .past-talks-section');
        if (pastTalksSection) {
            pastTalksSection.classList.add('is-collapsed');
            pastTalksSection.hidden = true;
            pastTalksSection.setAttribute('aria-hidden', 'true');
        }

        // Ensure viewer-section is inserted below past-talks-section (without wiping other content)
        let viewerSection = main.querySelector(':scope > .viewer-section');
        if (!viewerSection) {
            viewerSection = document.createElement('section');
            viewerSection.className = 'viewer-section';
            if (pastTalksSection) {
                pastTalksSection.insertAdjacentElement('afterend', viewerSection);
            } else {
                main.appendChild(viewerSection);
            }
        }

        viewerSection.classList.remove('is-collapsed');
        viewerSection.hidden = false;
        viewerSection.setAttribute('aria-hidden', 'false');
        viewerSection.innerHTML = viewerInnerHTML;
        
        // When opening the video viewer (incl. Edit types), jump back to the top.
        requestAnimationFrame(() => scrollHomeToTop());
        
        // Populate morevideos container with latest 20 videos
        populateMoreVideosCards(post.id);
        
        // Match morevideos container height to post content height
        setTimeout(() => {
            matchMoreVideosHeight();
        }, 100);
        
        // Add click listener to video container for mobile fullscreen
        setTimeout(() => {
            const videoContainer = document.getElementById('videoContainer');
            if (videoContainer) {
                videoContainer.addEventListener('click', function() {
                    // Only enter fullscreen on mobile devices
                    if (window.innerWidth <= 768) {
                        enterFullscreenVideo();
                    }
                });
            }
        }, 100);
    }
}

// Show the blog feed (original content)
async function showBlogFeed() {
    document.body.classList.add('home-view');
    setPastTalksOpenState(true);
    const main = document.querySelector('.everything');
    if (main) {
        const viewerSection = main.querySelector(':scope > .viewer-section');
        if (viewerSection) {
            viewerSection.classList.add('is-collapsed');
            viewerSection.hidden = true;
            viewerSection.setAttribute('aria-hidden', 'true');
        }
        if (!main.querySelector(':scope > .home-section')) {
            await showFeedContent();
        }

        let videoSection = main.querySelector(':scope > .past-talks-section');
        if (!videoSection) {
            videoSection = document.createElement('section');
            videoSection.className = 'past-talks-section is-collapsed';
            videoSection.hidden = true;
            videoSection.setAttribute('aria-hidden', 'true');
            main.appendChild(videoSection);
        }

        // Make Past talks section visible immediately on nav click.
        videoSection.classList.remove('is-collapsed');
        videoSection.hidden = false;
        videoSection.setAttribute('aria-hidden', 'false');

        // Ensure posts are loaded before building Past talks (so event badges can be populated)
        if (!allPosts || allPosts.length === 0) {
            await loadPostsFromFirebase();
        }
        
        setActiveNavView('past-talks');
        videoSection.innerHTML = `
                <div class="past-talks-wrapper">
                <div class="section-header">
                    <div class="past-talks-event-row">
                        <div class="filter-tabs" id="eventFilters">
                            <button class="filter-btn active" data-category="all">All events</button>
                        </div>
                    </div>
                    <div class="filter-tabs topic-filters" id="topicFilters">
                        <button class="filter-btn topic-btn active" data-topic="all">All</button>
                    </div>
                    <div class="past-talks-search-wrap">
                        <input type="search" id="pastTalksSearch" class="past-talks-search-input" placeholder="Search..." autocomplete="off" aria-label="Search">
                    </div>
                </div>
                <div class="blog-grid" id="blogGrid">
                    <!-- Blog posts will be loaded here -->
                </div>
                <div class="load-more-container">
                <button type="button" class="feed-load-more-btn" id="loadMoreBtn" aria-label="Load more">${UI_CHEVRON_DOWN_SVG}</button>
                </div>
                </div>
        `;
        
        // Re-render posts and setup event listeners
        // Update global variables after creating new HTML
        blogGrid = document.getElementById('blogGrid');
        loadMoreBtn = document.getElementById('loadMoreBtn');
        
        // Populate event badges directly (so we always have them when Past talks is shown)
        const eventFiltersEl = document.getElementById('eventFilters');
        if (eventFiltersEl) {
            const categories = getUniqueCategories();
            const categoryButtons = categories.map(cat =>
                `<button class="filter-btn" data-category="${cat.replace(/"/g, '&quot;')}">${cat}</button>`
            ).join('');
            eventFiltersEl.innerHTML = `<button class="filter-btn active" data-category="all">All events</button>${categoryButtons}`;
        }
        filterBtns = document.querySelectorAll('.filter-btn:not(.topic-btn)');
        
        // Populate topic filters and other UI
        populateFilters();
        
        // Past talks search: filter video posts by search query
        const pastTalksSearchInput = document.getElementById('pastTalksSearch');
        if (pastTalksSearchInput) {
            pastTalksSearchInput.value = searchQuery;
            pastTalksSearchInput.addEventListener('input', function() {
                searchQuery = this.value.trim();
                resetPastTalksPagination();
                renderPosts();
            });
        }

        resetPastTalksPagination();
        renderPosts();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const target = getPastTalksPostsPerBatch();
                if (target !== postsToShow) {
                    postsToShow = target;
                    renderPosts();
                }
            });
        });
        setupEventListeners();
        
        // Setup topic button event listeners after HTML is created
        setupTopicButtonListeners();
        scrollHomeToTop();
    }
}

const firebaseFeedCache = {
    data: null,
    timestamp: null,
    ttl: 5 * 60 * 1000, // 5 minutes cache
    fetchPromise: null,
};

function mapFirestoreDocToFeedRecord(docSnap, forcedRowId) {
    const raw = (docSnap && typeof docSnap.data === 'function' ? docSnap.data() : {}) || {};
    const normalized = { ...raw };
    // Keep compatibility with existing card logic that reads record.fields.URL first.
    if (!normalized.URL && normalized.Youtube) {
        normalized.URL = normalized.Youtube;
    }
    const created =
        raw.createdTime ||
        raw.createdAt ||
        raw.updatedAt ||
        (docSnap && docSnap.createTime && typeof docSnap.createTime.toDate === 'function'
            ? docSnap.createTime.toDate().toISOString()
            : undefined) ||
        new Date().toISOString();
    const id =
        forcedRowId != null && String(forcedRowId).trim()
            ? String(forcedRowId).trim()
            : docSnap && docSnap.id
              ? docSnap.id
              : '';
    return {
        id: id,
        fields: normalized,
        createdTime: created,
    };
}

/**
 * Row IDs for layout `tbs/Content/{rowId}/item`.
 * REST :listCollectionIds is not usable from the browser with the Web API key (403); read an index array/map on document tbs/Content instead.
 */
function rowIdsFromTbsContentParentData(data) {
    if (!data || typeof data !== 'object') return [];
    const arrayKeys = [
        'rowIds',
        'ids',
        'contentIds',
        'contentItemIds',
        'itemIds',
        'order',
        'contentOrder',
        'documents',
    ];
    for (let i = 0; i < arrayKeys.length; i++) {
        const k = arrayKeys[i];
        const v = data[k];
        if (Array.isArray(v) && v.length) {
            const out = v
                .map((x) => String(x != null ? x : '').trim())
                .filter(Boolean);
            if (out.length) return out;
        }
    }
    const mapKeys = ['items', 'content', 'rows', 'byId', 'entries'];
    for (let j = 0; j < mapKeys.length; j++) {
        const mk = mapKeys[j];
        const m = data[mk];
        if (m && typeof m === 'object' && !Array.isArray(m)) {
            const keys = Object.keys(m).filter((id) => id && id !== 'item');
            if (keys.length) return keys;
        }
    }
    return [];
}

async function resolveTbsContentRowIds(db) {
    const parentSnap = await withTimeout(
        db.collection('tbs').doc('Content').get(),
        15000,
        'tbs/Content parent read'
    );
    let fromManifest = [];
    if (parentSnap && parentSnap.exists) {
        fromManifest = rowIdsFromTbsContentParentData(parentSnap.data() || {});
        if (fromManifest.length) {
            return fromManifest;
        }
    }
    if (!fromManifest.length) {
        console.warn(
            'No content row index on document tbs/Content. Add an array field rowIds (or order, ids, …) listing each subcollection id, or open the backend Content tab once so it can rebuild the index.'
        );
    }
    return [];
}

/** Canonical layout: `tbs/Content/{rowId}/item` — one document `item` per row. */
async function fetchTbsContentItemLayoutRows(db) {
    const subIds = await resolveTbsContentRowIds(db);
    if (!subIds.length) return [];
    const rows = [];
    const chunkSize = 25;
    for (let i = 0; i < subIds.length; i += chunkSize) {
        const chunk = subIds.slice(i, i + chunkSize);
        const snaps = await Promise.all(
            chunk.map((rowId) =>
                withTimeout(
                    db.collection('tbs').doc('Content').collection(rowId).doc('item').get(),
                    12000,
                    'tbs/Content/' + rowId + '/item read'
                ).catch(function () {
                    return null;
                })
            )
        );
        for (let j = 0; j < chunk.length; j++) {
            const rowId = chunk[j];
            const snap = snaps[j];
            if (snap && snap.exists) {
                rows.push(mapFirestoreDocToFeedRecord(snap, rowId));
            }
        }
    }
    return rows;
}

async function fetchFeedFromFirebaseCollectionRef(collectionRef) {
    const snap = await withTimeout(collectionRef.get(), 15000, 'Firestore feed collection read');
    if (!snap || snap.empty) return [];
    const rows = [];
    snap.forEach((docSnap) => {
        rows.push(mapFirestoreDocToFeedRecord(docSnap));
    });
    return rows;
}

async function fetchFeedFromCollectionDocs(db, collectionName) {
    const snap = await withTimeout(
        db.collection(collectionName).get(),
        15000,
        `Firestore ${collectionName} collection read`
    );
    if (!snap || snap.empty) return [];
    const rows = [];
    snap.forEach((docSnap) => {
        rows.push(mapFirestoreDocToFeedRecord(docSnap));
    });
    return rows;
}

function mapRawFeedObjectToRecord(raw, idx, keyHint) {
    const obj = (raw && typeof raw === 'object') ? raw : {};
    const normalized = { ...obj };

    const nestedCandidate =
        (obj.fields && typeof obj.fields === 'object' && obj.fields) ||
        (obj.data && typeof obj.data === 'object' && obj.data) ||
        (obj.payload && typeof obj.payload === 'object' && obj.payload) ||
        (obj.item && typeof obj.item === 'object' && obj.item) ||
        null;

    const source = nestedCandidate ? { ...obj, ...nestedCandidate } : obj;

    const pick = (...keys) => {
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (
                Object.prototype.hasOwnProperty.call(source, k) &&
                source[k] != null &&
                source[k] !== ''
            ) {
                return source[k];
            }
        }
        return undefined;
    };

    // Canonicalize common variants so downstream card logic can stay unchanged.
    normalized.Title = pick('Title', 'title', 'headline') || '';
    normalized.Name = pick('Name', 'name') || '';
    normalized.Type = pick('Type', 'type', 'category') || '';
    normalized.Date = pick('Date', 'date', 'createdAt', 'created_at') || '';
    normalized.Excerpt = pick('Excerpt', 'excerpt', 'summary', 'text') || '';
    normalized.Content = pick('Content', 'content', 'body', 'description', 'text') || '';
    normalized.Event = pick('Event', 'event', 'Events', 'events') || '';
    normalized.Topic = pick('Topic', 'topic', 'topics', 'Tags', 'tags') || '';
    normalized.Fieldcolour = pick('Fieldcolour', 'fieldcolour', 'fieldColor', 'fieldcolor') || '';
    normalized.Featured = pick('Featured', 'featured') || '';
    normalized.Published = pick('Published', 'published') || '';
    normalized.Image = pick('Image', 'image', 'thumbnail', 'thumb') || '';
    normalized.Youtube = pick('Youtube', 'youtube', 'YouTube', 'video', 'videoUrl', 'video_url') || '';
    if (!normalized.URL) {
        normalized.URL = pick('URL', 'url', 'Link', 'link', 'Video URL', 'YouTube URL', 'Youtube URL') || normalized.Youtube || '';
    }

    // Some payloads store the real fields under nested maps.
    if (nestedCandidate) {
        Object.assign(normalized, nestedCandidate);
        if (!normalized.URL && normalized.Youtube) normalized.URL = normalized.Youtube;
    }
    const derivedId =
        String(obj.id || obj.docId || obj.slug || keyHint || '').trim() ||
        `content-${idx + 1}`;
    return {
        id: derivedId,
        fields: normalized,
        createdTime: obj.createdTime || obj.createdAt || obj.updatedAt || new Date().toISOString(),
    };
}

function pickFirstReadableStringField(fields, preferredKeys) {
    if (!fields || typeof fields !== 'object') return '';
    const keys = Object.keys(fields);
    for (let i = 0; i < preferredKeys.length; i++) {
        const k = preferredKeys[i];
        if (Object.prototype.hasOwnProperty.call(fields, k)) {
            const v = fields[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
    }
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = fields[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

function pickContentEntriesFromTbsContentDoc(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const candidateKeys = [
        'content item',
        'content items',
        'content-item',
        'content-items',
        'contentitem',
        'contentitems',
        'items',
        'records',
        'content',
        'Content',
        'entries',
        'rows',
        'data',
    ];
    for (let i = 0; i < candidateKeys.length; i++) {
        const key = candidateKeys[i];
        const candidate = raw[key];
        if (Array.isArray(candidate)) {
            return candidate.map((entry, idx) => ({ entry, keyHint: `${key}-${idx + 1}` }));
        }
        if (candidate && typeof candidate === 'object') {
            const mapped = Object.entries(candidate)
                .filter(([, v]) => v && typeof v === 'object')
                .map(([k, v]) => ({ entry: v, keyHint: k }));
            if (mapped.length > 0) return mapped;
        }
    }
    // Last-resort: treat top-level object as keyed record map, object values only.
    return Object.entries(raw)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([k, v]) => ({ entry: v, keyHint: k }));
}

// Fetch shared content records from Firestore document tbs/Content.
async function fetchNewsFeed() {
    if (firebaseFeedCache.fetchPromise) {
        return firebaseFeedCache.fetchPromise;
    }
    if (
        firebaseFeedCache.data &&
        firebaseFeedCache.timestamp &&
        Date.now() - firebaseFeedCache.timestamp < firebaseFeedCache.ttl
    ) {
        return firebaseFeedCache.data;
    }

    firebaseFeedCache.fetchPromise = (async () => {
    try {
        const db = getFirestore();
        // Canonical: tbs/Content/{rowId}/item (document `item` holds all fields per row).
        let records = await fetchTbsContentItemLayoutRows(db);
        if (records.length) {
            console.info('Feed source: tbs/Content/*/item (per-row subcollections)');
            firebaseFeedCache.data = records;
            firebaseFeedCache.timestamp = Date.now();
            return records;
        }

        const recordsFromDoc = async (collectionName, docName) => {
            const snap = await withTimeout(
                db.collection(collectionName).doc(docName).get(),
                15000,
                `Firestore ${collectionName}/${docName} doc read`
            );
            if (!snap || !snap.exists) return [];
            const raw = snap.data() || {};
            const entries = pickContentEntriesFromTbsContentDoc(raw);
            return entries
                .map(({ entry, keyHint }, idx) => mapRawFeedObjectToRecord(entry, idx, keyHint))
                .filter((r) => r && r.fields && typeof r.fields === 'object');
        };

        const recordsFromItemsSubcollection = async (collectionName, docName) => {
            const itemCollectionNames = [
                'content item',
                'content items',
                'contentitem',
                'content-item',
                'items',
                'item',
                'Content item',
                'Content items',
                'ContentItem',
                'ContentItems',
            ];
            for (let i = 0; i < itemCollectionNames.length; i++) {
                const sub = itemCollectionNames[i];
                const rows = await fetchFeedFromFirebaseCollectionRef(
                    db.collection(collectionName).doc(docName).collection(sub)
                );
                if (rows.length) return rows;
            }
            return [];
        };

        const candidateRoots = [
            { collection: 'TBS', doc: 'Content' },
            { collection: 'TBS', doc: 'content' },
            { collection: 'tbs', doc: 'Content' },
            { collection: 'tbs', doc: 'content' },
        ];
        records = [];
        for (let i = 0; i < candidateRoots.length && !records.length; i++) {
            const root = candidateRoots[i];
            records = await recordsFromItemsSubcollection(root.collection, root.doc);
            if (records.length) {
                console.info(`Feed source: ${root.collection}/${root.doc}/(items-like subcollection)`);
                break;
            }
            records = await recordsFromDoc(root.collection, root.doc);
            if (records.length) {
                console.info(`Feed source: ${root.collection}/${root.doc} (document payload)`);
                break;
            }
        }
        if (!records.length) {
            // Last resort: collection-as-rows
            records = await fetchFeedFromCollectionDocs(db, 'TBS');
            if (records.length) console.info('Feed source: TBS (collection docs)');
        }
        if (!records.length) {
            records = await fetchFeedFromCollectionDocs(db, 'tbs');
            if (records.length) console.info('Feed source: tbs (collection docs)');
        }

        if (records.length) {
            firebaseFeedCache.data = records;
            firebaseFeedCache.timestamp = Date.now();
        } else {
            // Do not cache empty discoveries; path/data may appear shortly or vary by shape.
            firebaseFeedCache.data = null;
            firebaseFeedCache.timestamp = 0;
        }
        return records;
    } catch (error) {
        console.error('Error fetching news feed:', error);
        // Don't redirect to event page - just return empty array
        return [];
    } finally {
        firebaseFeedCache.fetchPromise = null;
    }
    })();

    return firebaseFeedCache.fetchPromise;
}

/** One horizontal slider block: sync dots with scroll (introslider, programme, or speakers track). */
function wireOneIntrostyleSlider(wrapper) {
    const introsliderEl = wrapper.querySelector('.speakerslider-track')
        || wrapper.querySelector('.introslider, .programme-slider, .speakerslider');
        const indicatorsEl = wrapper.querySelector('.introslider-indicators');
        if (!introsliderEl || !indicatorsEl) return;
        const dots = indicatorsEl.querySelectorAll('.introslider-dot');
        if (!dots.length) return;
        /** Active slide when slides are narrower than the viewport (e.g. 95vw cards + peek). */
        function nearestSlideIndex() {
            const sl = introsliderEl.scrollLeft;
            const kids = introsliderEl.children;
            if (!kids.length) return 0;
            let bestIdx = 0;
            let bestDelta = Infinity;
            for (let j = 0; j < kids.length; j++) {
                const left = kids[j].offsetLeft;
                const delta = Math.abs(sl - left);
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestIdx = j;
                }
            }
            return Math.min(bestIdx, dots.length - 1);
        }
        function updateActiveDot() {
            const i = nearestSlideIndex();
            dots.forEach((d, j) => d.classList.toggle('active', j === i));
        }
        introsliderEl.addEventListener('scroll', updateActiveDot);
        updateActiveDot();
        dots.forEach((dot, i) => {
            dot.addEventListener('click', () => {
                const kid = introsliderEl.children[i];
                const left = kid ? kid.offsetLeft : i * introsliderEl.clientWidth;
                introsliderEl.scrollTo({ left, behavior: 'smooth' });
        });
    });
}

/**
 * Home hero introslider: Safari (and some macOS overlay modes) ignore ::-webkit-scrollbar styling.
 * Desktop-only custom bar — transparent track, magenta thumb — synced to scroll position.
 */
function wireHomeIntrosliderScrollbar() {
    const wrapper = document.querySelector('.home-section .introslider-wrapper');
    if (!wrapper || wrapper.dataset.homeScrollbarWired === '1') return;
    const scrollEl = wrapper.querySelector(':scope > .introslider');
    const bar = wrapper.querySelector(':scope > .home-introslider-scrollbar');
    const thumb = bar && bar.querySelector('.home-introslider-scrollbar-thumb');
    if (!scrollEl || !thumb) return;

    const track = thumb.parentElement;
    if (!track) return;

    function update() {
        const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
        const trackW = track.clientWidth;
        if (trackW <= 0) return;
        if (maxScroll <= 0) {
            thumb.style.width = '100%';
            thumb.style.transform = 'translateX(0)';
            bar.classList.add('home-introslider-scrollbar--nooverflow');
            return;
        }
        bar.classList.remove('home-introslider-scrollbar--nooverflow');
        const thumbW = Math.max((scrollEl.clientWidth / scrollEl.scrollWidth) * trackW, 22);
        const maxLeft = Math.max(trackW - thumbW, 0);
        const left = maxLeft > 0 ? (scrollEl.scrollLeft / maxScroll) * maxLeft : 0;
        thumb.style.width = `${thumbW}px`;
        thumb.style.transform = `translateX(${left}px)`;
    }

    scrollEl.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(update);
        ro.observe(scrollEl);
        ro.observe(track);
    }
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(update).catch(function () {
            update();
        });
    }
    requestAnimationFrame(update);
    wrapper.dataset.homeScrollbarWired = '1';
}

/**
 * Home programme row: same custom scrollbar as introslider (Safari-safe), inside .programmeslider-innerwrapper.
 */
function wireProgrammeSliderScrollbar() {
    document.querySelectorAll('.programme-section').forEach(function (wrapper) {
        if (wrapper.dataset.programmeScrollbarWired === '1') return;
        const inner = wrapper.querySelector(':scope > .programmeslider-innerwrapper');
        if (!inner) return;
        const scrollEl = inner.querySelector('.programme-slider');
        const bar = inner.querySelector('.home-introslider-scrollbar');
        const thumb = bar && bar.querySelector('.home-introslider-scrollbar-thumb');
        if (!scrollEl || !thumb) return;

        const track = thumb.parentElement;
        if (!track) return;

        function update() {
            const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
            const trackW = track.clientWidth;
            if (trackW <= 0) return;
            if (maxScroll <= 0) {
                thumb.style.width = '100%';
                thumb.style.transform = 'translateX(0)';
                bar.classList.add('home-introslider-scrollbar--nooverflow');
                return;
            }
            bar.classList.remove('home-introslider-scrollbar--nooverflow');
            const thumbW = Math.max((scrollEl.clientWidth / scrollEl.scrollWidth) * trackW, 22);
            const maxLeft = Math.max(trackW - thumbW, 0);
            const left = maxLeft > 0 ? (scrollEl.scrollLeft / maxScroll) * maxLeft : 0;
            thumb.style.width = `${thumbW}px`;
            thumb.style.transform = `translateX(${left}px)`;
        }

        scrollEl.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(update);
            ro.observe(scrollEl);
            ro.observe(track);
        }
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(update).catch(function () {
                update();
            });
        }
        requestAnimationFrame(update);
        wrapper.dataset.programmeScrollbarWired = '1';
    });
}

/** Home speakers row: same custom scrollbar thumb as programme (native bar hidden on desktop). */
function wireSpeakersSliderScrollbar() {
    document.querySelectorAll('.speaker-section').forEach(function (wrapper) {
        if (wrapper.dataset.speakersScrollbarWired === '1') return;
        const scrollEl = wrapper.querySelector('.speakerslider-track');
        const bar = wrapper.querySelector('.speakers-inner-wrapper .home-introslider-scrollbar');
        const thumb = bar && bar.querySelector('.home-introslider-scrollbar-thumb');
        if (!scrollEl || !thumb) return;

        const track = thumb.parentElement;
        if (!track) return;

        function update() {
            const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth;
            const trackW = track.clientWidth;
            if (trackW <= 0) return;
            if (maxScroll <= 0) {
                thumb.style.width = '100%';
                thumb.style.transform = 'translateX(0)';
                bar.classList.add('home-introslider-scrollbar--nooverflow');
                return;
            }
            bar.classList.remove('home-introslider-scrollbar--nooverflow');
            const thumbW = Math.max((scrollEl.clientWidth / scrollEl.scrollWidth) * trackW, 22);
            const maxLeft = Math.max(trackW - thumbW, 0);
            const left = maxLeft > 0 ? (scrollEl.scrollLeft / maxScroll) * maxLeft : 0;
            thumb.style.width = `${thumbW}px`;
            thumb.style.transform = `translateX(${left}px)`;
        }

        scrollEl.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(update);
            ro.observe(scrollEl);
            ro.observe(track);
        }
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(update).catch(function () {
                update();
            });
        }
        requestAnimationFrame(update);
        wrapper.dataset.speakersScrollbarWired = '1';
    });
}

// Wire slider indicator dots to introslider scroll position and click-to-scroll (mobile)
// Supports multiple .introslider-wrapper blocks (e.g. home + TBS27 programme row).
function wireSliderIndicators() {
    const main = document.querySelector('.everything');
    if (!main) return;
    main.querySelectorAll('.introslider-wrapper, .programme-section, .speaker-section').forEach((wrapper) => {
        wireOneIntrostyleSlider(wrapper);
    });
    wireHomeIntrosliderScrollbar();
    wireProgrammeSliderScrollbar();
}

/** Hotel Alex — same URL in introslider Location slide and home Location band. */
const TBS_HOTEL_ALEX_URL = 'https://www.hotelalexzermatt.com/en/';

/** Event body for home About slide */
const ABOUT_EVENT_INNER_HTML = `
                                <h3 class="about-title introslider-title">Event</h3>
                                <p>How do we think, decide and act when medicine matters the most? TBS is a forum dedicated to the early management of critical illness. It is about first-hour critical care, physiology, behaviour and emerging technologies.<br><br></p>
`;

/** Location body for home Location slide */
const ABOUT_LOCATION_INNER_HTML = `
                                <h3 class="about-title introslider-title">Location</h3>
                                <p>TBS is held in Zermatt, Switzerland, as a setting that encourages presence, conversation, and reflection. The iconic four-star <a href="${TBS_HOTEL_ALEX_URL}" target="_blank" rel="noopener noreferrer">Hotel Alex</a> is the venue and the heart of the event.<br><br></p>
`;

/** Register body for home Register slide */
const ABOUT_REGISTER_INNER_HTML = `
                                <h3 class="about-title introslider-title">Register</h3>
                                <p>TBS is kept small to facilitate sustained interaction between participants, both within and beyond the formal programme. TBS is not designed to scale. Attendance is limited. Participation is expected.</p>
`;

/** Past talks body for home Past talks slide */
const ABOUT_PAST_TALKS_INNER_HTML = `
                                <h3 class="about-title introslider-title">Past talks</h3>
                                <p>We are believers in the open access ethos and intend to bring TBS to a wider audience. Find all recorded talks here or on our social media.</p>
`;

/** TBS on Social body for home social slide */
const ABOUT_SOCIAL_INNER_HTML = `
                                <h3 class="about-title introslider-title">TBS on Social</h3>
                                <p>Find all recorded content on the TBS YouTube channel or other platforms.</p>
`;

/** Event + Location body (programme .about slide) */
const ABOUT_EVENT_LOCATION_INNER_HTML = `
${ABOUT_EVENT_INNER_HTML}
${ABOUT_LOCATION_INNER_HTML}
`;

/** Home introslider: About panel before featured-video */
const FEATURED_ABOUT_SLIDER_HTML = `
                    <div class="about">
                        <div class="about-text">
${ABOUT_EVENT_INNER_HTML}
                </div>
                        <h3 class="featured-bottom-title introslider-title">About</h3>
            </div>
        `;

/** Home introslider: duplicated About panel as Location container → scroll to home Location band */
const FEATURED_LOCATION_SLIDER_HTML = `
                    <div class="location introslider-clickable" role="button" tabindex="0" aria-label="Scroll to location section">
                        <div class="about-text">
${ABOUT_LOCATION_INNER_HTML}
                        </div>
                        <h3 class="featured-bottom-title introslider-title">Location</h3>
            </div>
        `;

/** Home introslider: Register panel */
const FEATURED_REGISTER_SLIDER_HTML = `
                    <div class="register introslider-clickable">
                        <div class="about-text">
${ABOUT_REGISTER_INNER_HTML}
                </div>
                        <h3 class="featured-bottom-title introslider-title">Register</h3>
                        </div>
`;

/** Programme overview copy: hero introslider + first card of home programme band (not per-day schedule HTML). */
const HOME_PROGRAMME_TEASER_ABOUT_INNER_HTML = `
                                <h3 class="about-title introslider-title">Programme</h3>
                                <p>We base ourselves on themed sessions in the mornings and evenings in the Hotel Alex conference room. Between sessions we have the afternoon workshops.</p>
`;

/** Home introslider: Programme teaser → scroll to programme band */
const FEATURED_ABOUT_PROGRAMME_SLIDER_HTML = `
                    <div class="about-programme introslider-clickable" role="button" tabindex="0" aria-label="Scroll to programme section">
                        <div class="about-text">
${HOME_PROGRAMME_TEASER_ABOUT_INNER_HTML}
                            </div>
                        <h3 class="featured-bottom-title introslider-title">Programme</h3>
                        </div>
`;

/** Home introslider: Speakers teaser -> scroll to speakers row */
const FEATURED_ABOUT_SPEAKERS_SLIDER_HTML = `
                    <div class="about-speakers introslider-clickable" role="button" tabindex="0" aria-label="Scroll to speakers section">
                        <div class="about-text">
                                <h3 class="about-title introslider-title">Speakers</h3>
                                <p>Our speakers are carefully selected from the cutting edge of critical care, resuscitation and cognitive sciences. We then ask them to go above and beyond the studies and the guidelines.</p>
                            </div>
                        <h3 class="featured-bottom-title introslider-title">Speakers</h3>
                        </div>
`;

/** Home introslider: Past talks panel */
const FEATURED_PAST_TALKS_SLIDER_HTML = `
                    <div class="pasttalks introslider-clickable">
                        <div class="about-text">
${ABOUT_PAST_TALKS_INNER_HTML}
                    </div>
                        <h3 class="featured-bottom-title introslider-title">Past talks</h3>
                    </div>
`;

/** Home introslider: TBS on Social panel */
const FEATURED_SOCIAL_SLIDER_HTML = `
                    <div class="tbsonsocial">
                        <div class="about-text">
${ABOUT_SOCIAL_INNER_HTML}
                        </div>
                    </div>
`;

/** Home: sponsors band (direct child of `.home-section`, directly below Event band, above Latest feed). */
const HOME_SPONSORS_SECTION_HTML = `
                <div class="sponsors-section" role="region" aria-label="Sponsors">
                    <div class="sponsors-section-inner-wrapper">
                        <div class="sponsor-logos">
                            <div class="sponsor-logo-slot">
                                <img src="images/Sponsors/corpulsgold.png" alt="Corpuls" class="sponsors-logo-image" loading="eager" decoding="async">
                            </div>
                            <div class="sponsor-logo-slot">
                                <img src="images/Sponsors/hamiltongold.png" alt="Hamilton" class="sponsors-logo-image" loading="eager" decoding="async">
                            </div>
                            <div class="sponsor-logo-slot">
                                <img src="images/Sponsors/heinegold.png" alt="Heine" class="sponsors-logo-image" loading="eager" decoding="async">
                            </div>
                            <div class="sponsor-logo-slot">
                                <img src="images/Sponsors/intersurgicalgold.png" alt="Intersurgical" class="sponsors-logo-image" loading="eager" decoding="async">
                            </div>
                            <div class="sponsor-logo-slot">
                                <img src="images/Sponsors/qinflowgold.png" alt="Qinflow" class="sponsors-logo-image" loading="eager" decoding="async">
                            </div>
                        </div>
                    </div>
                </div>
`;

/** Max rendered logo height (px); row logic still scales down responsively as space shrinks. */
function homeSponsorLogosMaxHeightPx() {
    return 40;
}

function sponsorLogosRowGapPx(rowEl) {
    if (!rowEl) return 0;
    const cs = getComputedStyle(rowEl);
    const raw = cs.columnGap && cs.columnGap !== 'normal' ? cs.columnGap : cs.gap;
    if (!raw || raw === 'normal') return 0;
    const first = String(raw).trim().split(/\s+/)[0];
    const x = parseFloat(first);
    return Number.isFinite(x) ? x : 0;
}

/** One shared rendered height for every logo; scales down so the row fits `row.clientWidth` (aspect ratios preserved). */
function layoutHomeSponsorLogosRowApply(sponsorsSectionEl) {
    if (!sponsorsSectionEl) return;
    const row = sponsorsSectionEl.querySelector('.sponsor-logos');
    if (!row) return;
    if (row.classList.contains('sponsor-logos-column')) {
        const imagesCol = Array.from(row.querySelectorAll('img.sponsors-logo-image'));
        for (let i = 0; i < imagesCol.length; i++) {
            const im = imagesCol[i];
            im.style.height = '';
            im.style.width = '';
            im.style.maxWidth = '';
            im.style.maxHeight = '';
        }
        return;
    }
    const images = Array.from(row.querySelectorAll('img.sponsors-logo-image'));
    if (!images.length) return;

    const w = row.clientWidth;
    if (!(w > 0)) return;

    let sumWoverH = 0;
    for (let i = 0; i < images.length; i++) {
        const im = images[i];
        if (!im.naturalWidth || !im.naturalHeight) return;
        sumWoverH += im.naturalWidth / im.naturalHeight;
    }
    if (!(sumWoverH > 0)) return;

    const gapPx = sponsorLogosRowGapPx(row);
    const gapsWidth = Math.max(0, images.length - 1) * gapPx;
    const maxH = homeSponsorLogosMaxHeightPx();
    const hFit = (w - gapsWidth) / sumWoverH;
    const hUsed = Math.max(8, Math.min(maxH, hFit));

    for (let i = 0; i < images.length; i++) {
        const im = images[i];
        im.style.height = hUsed + 'px';
        im.style.width = 'auto';
        im.style.maxWidth = 'none';
        im.style.maxHeight = 'none';
    }
}

function wireHomeSponsorLogosRowLayout(sponsorsSectionEl) {
    if (!sponsorsSectionEl) return;
    const row = sponsorsSectionEl.querySelector('.sponsor-logos');
    if (!row) return;

    if (row.classList.contains('sponsor-logos-column')) {
        if (row._homeSponsorLogoResizeObserver) {
            row._homeSponsorLogoResizeObserver.disconnect();
            row._homeSponsorLogoResizeObserver = null;
        }
        if (row._homeSponsorLogoMq && row._homeSponsorLogoMqListener) {
            if (row._homeSponsorLogoMq.removeEventListener) {
                row._homeSponsorLogoMq.removeEventListener('change', row._homeSponsorLogoMqListener);
            } else if (row._homeSponsorLogoMq.removeListener) {
                row._homeSponsorLogoMq.removeListener(row._homeSponsorLogoMqListener);
            }
            row._homeSponsorLogoMq = null;
            row._homeSponsorLogoMqListener = null;
        }
        if (row._homeSponsorLogoImgLoadAbort) {
            row._homeSponsorLogoImgLoadAbort.abort();
            row._homeSponsorLogoImgLoadAbort = null;
        }
        layoutHomeSponsorLogosRowApply(sponsorsSectionEl);
        return;
    }

    if (row._homeSponsorLogoResizeObserver) {
        row._homeSponsorLogoResizeObserver.disconnect();
        row._homeSponsorLogoResizeObserver = null;
    }
    if (row._homeSponsorLogoMq && row._homeSponsorLogoMqListener) {
        if (row._homeSponsorLogoMq.removeEventListener) {
            row._homeSponsorLogoMq.removeEventListener('change', row._homeSponsorLogoMqListener);
        } else if (row._homeSponsorLogoMq.removeListener) {
            row._homeSponsorLogoMq.removeListener(row._homeSponsorLogoMqListener);
        }
        row._homeSponsorLogoMq = null;
        row._homeSponsorLogoMqListener = null;
    }
    if (row._homeSponsorLogoImgLoadAbort) {
        row._homeSponsorLogoImgLoadAbort.abort();
        row._homeSponsorLogoImgLoadAbort = null;
    }

    let raf = 0;
    function schedule() {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () {
            raf = 0;
            layoutHomeSponsorLogosRowApply(sponsorsSectionEl);
        });
    }

    const images = Array.from(row.querySelectorAll('img.sponsors-logo-image'));
    const loadAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    row._homeSponsorLogoImgLoadAbort = loadAbort;
    images.forEach(function (im) {
        if (loadAbort) {
            im.addEventListener('load', schedule, { passive: true, signal: loadAbort.signal });
        } else {
            im.addEventListener('load', schedule, { passive: true });
        }
    });

    schedule();

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(function () {
            schedule();
        });
        ro.observe(row);
        row._homeSponsorLogoResizeObserver = ro;
    }

    const mq = window.matchMedia('(max-width: 768px)');
    const onMq = function () {
        schedule();
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
    row._homeSponsorLogoMq = mq;
    row._homeSponsorLogoMqListener = onMq;
}

/** Zermatt venue trailer in Location band; YouTube loop needs playlist=id when using loop=1 */
const HOME_LOCATION_TRAILER_VIDEO_ID = 'mC-1x81FQ0U';
const HOME_LOCATION_TRAILER_EMBED_SRC_HTML =
    'https://www.youtube.com/embed/' +
    HOME_LOCATION_TRAILER_VIDEO_ID +
    '?rel=0&amp;modestbranding=1&amp;playsinline=1&amp;autoplay=1&amp;mute=1&amp;loop=1&amp;playlist=' +
    HOME_LOCATION_TRAILER_VIDEO_ID;

/** Home: Event band — inner Prussian panel: `.eventintroduction` left, `.trailer-embed` right. */
const HOME_LOCATION_SECTION_HTML =
    `
                <div class="event-section" role="region" aria-label="Event introduction">
                    <img src="images/Sponsors/divider.png" alt="" class="event-section-divider" loading="lazy" decoding="async" aria-hidden="true">
                    <div class="event-section-inner-wrapper">
                        <div class="eventintroduction">
                            <h1 class="section-titles maintitle-heading">WELCOME TO TBS27</h1>
                            <div class="event-texts">
                                <div class="event-contents"></div>
                            </div>
                        </div>
                        <div class="trailer-embed">
                            <div class="embed-section" aria-label="Venue trailer video">
                                <div class="trailer">
                                    <div class="trailer-media">
                                        <iframe width="560" height="315" title="Venue trailer video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen src="${HOME_LOCATION_TRAILER_EMBED_SRC_HTML}" data-embed-src="${HOME_LOCATION_TRAILER_EMBED_SRC_HTML}"></iframe>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
`;

/** Home: speakers carousel (after sponsors); programme slider inserted after this row by displayNewsGrid */
const HOME_SPEAKERS_SLIDER_HTML = `
                <div class="speaker-section" id="speakers-section">
                    <div class="speakers-inner-wrapper">
                        <div class="speakerslider" aria-label="Speakers">
                            <div class="speakerslider-track">
                            </div>
                        </div>
                        <div class="home-introslider-scrollbar" aria-hidden="true">
                            <div class="home-introslider-scrollbar-track">
                                <div class="home-introslider-scrollbar-thumb"></div>
                            </div>
                        </div>
                    </div>
                </div>
`;

/** On-demand band (pale inner card) between Programme and Registration. */
const HOME_ONDEMAND_SECTION_HTML = `
                <div class="ondemand-section" role="region" aria-labelledby="home-ondemand-heading">
                    <div class="ondemand-inner-wrapper">
                        <h2 class="section-titles ondemand-section-title" id="home-ondemand-heading">TBS On-demand</h2>
                    </div>
                </div>
`;

/** Registration at bottom of home; order after .ondemand-section is fixed in displayNewsGrid. */
const HOME_REGISTRATION_OUTER_HTML = `
                <div class="registration-section" role="region" aria-labelledby="home-registration-heading">
                    <div class="registration-section-inner-wrapper">
                            <form class="registration-form" novalidate onsubmit="return false;" aria-label="Registration preview form">
                                <h3 class="section-titles registration-section-title" id="home-registration-heading">Registration</h3>
                                <p class="registration-manifesto">In order to facilitate interaction between participants TBS is intentionally kept small. Attendance is limited.</p>
                                <div class="registration-form-row registration-form-row--two-up">
                                    <div class="registration-field">
                                        <label for="reg-first-name">First name <span class="registration-required-asterisk">*</span></label>
                                        <input id="reg-first-name" name="firstName" type="text" autocomplete="given-name" required>
                                    </div>
                                    <div class="registration-field">
                                        <label for="reg-last-name">Last name <span class="registration-required-asterisk">*</span></label>
                                        <input id="reg-last-name" name="lastName" type="text" autocomplete="family-name" required>
                                    </div>
                                </div>
                                <div class="registration-form-row registration-form-row--two-up">
                                    <div class="registration-field">
                                        <label for="reg-email">Email <span class="registration-required-asterisk">*</span></label>
                                        <input id="reg-email" name="email" type="email" autocomplete="email" required>
                                    </div>
                                    <div class="registration-field">
                                        <label for="reg-email-confirm">Confirm email <span class="registration-required-asterisk">*</span></label>
                                        <input id="reg-email-confirm" name="emailConfirm" type="email" autocomplete="email" required>
                                    </div>
                                </div>
                                <div class="registration-form-row registration-form-row--two-up">
                                    <div class="registration-field">
                                        <label for="reg-city-region">City/region <span class="registration-required-asterisk">*</span></label>
                                        <input id="reg-city-region" name="cityRegion" type="text" autocomplete="address-level2" required>
                                    </div>
                                    <div class="registration-field">
                                        <label for="reg-country">Country <span class="registration-required-asterisk">*</span></label>
                                        <select id="reg-country" name="country" autocomplete="country-name" required>
                                            <option value="" disabled selected>Select country</option>
                                            <option value="Other (Enter into bio below.)">Other (Enter into bio below.)</option>
                                            <option value="Australia">Australia</option>
                                            <option value="Austria">Austria</option>
                                            <option value="Belgium">Belgium</option>
                                            <option value="Bosnia and Herzegovina">Bosnia and Herzegovina</option>
                                            <option value="Bulgaria">Bulgaria</option>
                                            <option value="Canada">Canada</option>
                                            <option value="Croatia">Croatia</option>
                                            <option value="Czech Republic">Czech Republic</option>
                                            <option value="Denmark">Denmark</option>
                                            <option value="Estonia">Estonia</option>
                                            <option value="Finland">Finland</option>
                                            <option value="France">France</option>
                                            <option value="Germany">Germany</option>
                                            <option value="Greece">Greece</option>
                                            <option value="Hungary">Hungary</option>
                                            <option value="Iceland">Iceland</option>
                                            <option value="India">India</option>
                                            <option value="Ireland">Ireland</option>
                                            <option value="Italy">Italy</option>
                                            <option value="Jersey">Jersey</option>
                                            <option value="Latvia">Latvia</option>
                                            <option value="Lithuania">Lithuania</option>
                                            <option value="Luxembourg">Luxembourg</option>
                                            <option value="Monaco">Monaco</option>
                                            <option value="Netherlands">Netherlands</option>
                                            <option value="New Zeeland">New Zeeland</option>
                                            <option value="Norway">Norway</option>
                                            <option value="Poland">Poland</option>
                                            <option value="Portugal">Portugal</option>
                                            <option value="Romania">Romania</option>
                                            <option value="Saudi Arabia">Saudi Arabia</option>
                                            <option value="Serbia">Serbia</option>
                                            <option value="Slovakia">Slovakia</option>
                                            <option value="Slovenia">Slovenia</option>
                                            <option value="Spain">Spain</option>
                                            <option value="Sweden">Sweden</option>
                                            <option value="Switzerland">Switzerland</option>
                                            <option value="UAE">UAE</option>
                                            <option value="Ukraine">Ukraine</option>
                                            <option value="United Kingdom">United Kingdom</option>
                                            <option value="United States">United States</option>
                                            <option value="South Africa">South Africa</option>
                                        </select>
                                    </div>
                                </div>
                                <div class="registration-form-row registration-form-row--two-up">
                                    <div class="registration-field">
                                        <label for="reg-employer-1">Employer 1 (Name/City) <span class="registration-required-asterisk">*</span></label>
                                        <input id="reg-employer-1" name="employer1" type="text" autocomplete="organization" required>
                                    </div>
                                    <div class="registration-field">
                                        <label for="reg-emplyer-2">Employer 2 (Name/City)</label>
                                        <input id="reg-emplyer-2" name="emplyer2" type="text" autocomplete="organization">
                                    </div>
                                </div>
                                <div class="registration-form-row registration-form-row--two-up">
                                    <div class="registration-field">
                                    <fieldset class="registration-fieldset" aria-label="Base medical speciality">
                                        <legend>Base medical speciality <span class="registration-required-asterisk">*</span></legend>
                                        <div class="registration-checkbox-group registration-checkbox-group--speciality">
                                            <label class="registration-speciality-option" for="reg-speciality-anaesthesiology">
                                                <input id="reg-speciality-anaesthesiology" name="baseSpeciality" type="checkbox" value="Anaesthesiology">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Anaesthesiology</span>
                                            </label>
                                            <label class="registration-speciality-option" for="reg-speciality-critical-care">
                                                <input id="reg-speciality-critical-care" name="baseSpeciality" type="checkbox" value="Critical Care">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Critical Care</span>
                                            </label>
                                            <label class="registration-speciality-option" for="reg-speciality-emergency-medicine">
                                                <input id="reg-speciality-emergency-medicine" name="baseSpeciality" type="checkbox" value="Emergency Medicine">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Emergency Medicine</span>
                                            </label>
                                            <label class="registration-speciality-option" for="reg-speciality-internal-medicine">
                                                <input id="reg-speciality-internal-medicine" name="baseSpeciality" type="checkbox" value="Internal Medicine">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Internal Medicine</span>
                                            </label>
                                            <label class="registration-speciality-option" for="reg-speciality-paramedic">
                                                <input id="reg-speciality-paramedic" name="baseSpeciality" type="checkbox" value="Paramedic">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Paramedic</span>
                                            </label>
                                            <label class="registration-speciality-option" for="reg-speciality-nursing">
                                                <input id="reg-speciality-nursing" name="baseSpeciality" type="checkbox" value="Nursing">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Nursing</span>
                                            </label>
                                            <label class="registration-speciality-option" for="reg-speciality-other">
                                                <input id="reg-speciality-other" name="baseSpeciality" type="checkbox" value="Other">
                                                <span class="registration-speciality-box" aria-hidden="true"></span>
                                                <span>Other</span>
                                            </label>
                                        </div>
                                    </fieldset>
                                    </div>
                                    <div class="registration-field">
                                    <fieldset class="registration-fieldset" aria-label="Level of training">
                                        <legend>Level of training <span class="registration-required-asterisk">*</span></legend>
                                        <div class="registration-checkbox-group">
                                            <label for="reg-level-consultant-physiscian">
                                                <input id="reg-level-consultant-physiscian" name="trainingLevel" type="radio" value="Consultant physiscian">
                                                <span>Consultant physiscian</span>
                                            </label>
                                            <label for="reg-level-registrar-physiscian">
                                                <input id="reg-level-registrar-physiscian" name="trainingLevel" type="radio" value="Registrar physiscian">
                                                <span>Registrar physiscian</span>
                                            </label>
                                            <label for="reg-level-specialist-paramedic">
                                                <input id="reg-level-specialist-paramedic" name="trainingLevel" type="radio" value="Specialist paramedic">
                                                <span>Specialist paramedic</span>
                                            </label>
                                            <label for="reg-level-paramedic-emt">
                                                <input id="reg-level-paramedic-emt" name="trainingLevel" type="radio" value="Paramedic/EMT">
                                                <span>Paramedic/EMT</span>
                                            </label>
                                            <label for="reg-level-specialist-nurse">
                                                <input id="reg-level-specialist-nurse" name="trainingLevel" type="radio" value="Specialist nurse">
                                                <span>Specialist nurse</span>
                                            </label>
                                            <label for="reg-level-nurse">
                                                <input id="reg-level-nurse" name="trainingLevel" type="radio" value="Nurse">
                                                <span>Nurse</span>
                                            </label>
                                            <label for="reg-level-other">
                                                <input id="reg-level-other" name="trainingLevel" type="radio" value="Other">
                                                <span>Other</span>
                                            </label>
                                        </div>
                                    </fieldset>
                                    </div>
                                </div>
                                <div class="registration-form-row">
                                    <div class="registration-field">
                                        <label for="reg-very-brief-bio">Very brief bio</label>
                                        <textarea id="reg-very-brief-bio" name="veryBriefBio" placeholder="This is a long text string"></textarea>
                                    </div>
                                </div>
                                <div class="registration-form-row">
                                    <fieldset class="registration-fieldset" aria-label="Have you attended TBS in the past">
                                        <legend>Have you attended TBS in the past?</legend>
                                        <div class="registration-checkbox-group">
                                            <label for="reg-attended-tbs-yes">
                                                <input id="reg-attended-tbs-yes" name="attendedTbsPast" type="radio" value="Yes">
                                                <span>Yes</span>
                                            </label>
                                            <label for="reg-attended-tbs-no">
                                                <input id="reg-attended-tbs-no" name="attendedTbsPast" type="radio" value="No">
                                                <span>No</span>
                                            </label>
                                        </div>
                                    </fieldset>
                                </div>
                                <div class="registration-form-row registration-form-row--actions">
                                    <button type="submit" class="registration-submit-btn">Submit registration</button>
                                    <p class="registration-smallprint">Submitting this form registers your interest; final confirmation and payment information will be sent by email.</p>
                                </div>
                            </form>
                    </div>
                </div>
`;

/** About copy (TBS27 programme flyer — introslider slide 2) */
const ABOUT_SECTION_HTML_PROGRAMME = `
                        <div class="about">
                            <img src="images/spacer.png" alt="" class="about-spacer" loading="lazy" decoding="async">
                            <div class="about-text">
${ABOUT_EVENT_LOCATION_INNER_HTML}
                            </div>
                            <img src="images/spacer.png" alt="" class="about-spacer" loading="lazy" decoding="async">
                        </div>
`;

function setupRegistrationEmailConfirmValidation(root) {
    if (!root) return;
    const emailInput = root.querySelector('#reg-email');
    const confirmInput = root.querySelector('#reg-email-confirm');
    if (!emailInput || !confirmInput) return;

    const syncConfirmEmailState = () => {
        const emailValue = String(emailInput.value || '').trim().toLowerCase();
        const confirmValue = String(confirmInput.value || '').trim().toLowerCase();
        const emailsMatch = emailValue !== '' && confirmValue !== '' && emailValue === confirmValue;
        const hasMismatch = !emailsMatch;

        confirmInput.classList.toggle('registration-email-mismatch', hasMismatch);
        if (hasMismatch) {
            confirmInput.setCustomValidity('Email addresses must match.');
        } else {
            confirmInput.setCustomValidity('');
        }
    };

    emailInput.addEventListener('input', syncConfirmEmailState);
    confirmInput.addEventListener('input', syncConfirmEmailState);
    syncConfirmEmailState();
}

/** Snow overlay on home hero poster `<picture>`; respects prefers-reduced-motion. */
function initPosterSnow() {
    const section = document.querySelector('body.home-view .home-section > picture');
    const canvas = section && section.querySelector('canvas.poster-snow-canvas');
    if (!section || !canvas) return;

    if (section.dataset.posterSnowInit === '1') return;
    section.dataset.posterSnowInit = '1';

    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        canvas.hidden = true;
        return;
    }

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    let flakes = [];
    let width = 0;
    let height = 0;
    let rafId = 0;
    let resizeObserver = null;

    function flakeCount() {
        return Math.min(90, Math.max(35, Math.floor((width || 600) / 14)));
    }

    /** Gentle horizontal drift (px/frame); gusts added in tick(). */
    const WIND_BASE = 1.05;

    function seed() {
        const n = flakeCount();
        flakes = [];
        const w = width || 1;
        const h = height || 1;
        const margin = 100;
        for (let i = 0; i < n; i++) {
            flakes.push({
                x: Math.random() * (w + margin * 2) - margin,
                y: Math.random() * h,
                r: Math.random() * 2.2 + 0.6,
                vy: Math.random() * 1.1 + 0.35,
                vx: Math.random() * 0.55 - 0.28,
                o: Math.random() * 0.45 + 0.28,
            });
        }
    }

    function resize() {
        const rect = section.getBoundingClientRect();
        width = Math.max(1, Math.round(rect.width));
        height = Math.max(1, Math.round(rect.height));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        seed();
    }

    function tick() {
        if (width < 2 || height < 2) {
            rafId = requestAnimationFrame(tick);
            return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        const t = performance.now() * 0.001;
        const gust =
            Math.sin(t * 1.75) * 0.22 +
            Math.sin(t * 2.9 + 1.1) * 0.11 +
            Math.sin(t * 4.3) * 0.06;
        const wrapX = 56;
        for (let i = 0; i < flakes.length; i++) {
            const f = flakes[i];
            const shear = (f.y / height) * 0.14;
            const flutter = Math.sin((height - f.y) * 0.022 + t * 2.4 + i * 0.07) * 0.09;
            f.x += WIND_BASE + gust + shear + flutter + f.vx * 0.5;
            f.y += f.vy;
            if (f.y > height + 6) {
                f.y = -6;
                f.x = Math.random() * (width + wrapX * 2) - wrapX;
            }
            if (f.x > width + wrapX) {
                f.x = -wrapX + Math.random() * wrapX * 0.6;
                f.y = Math.random() * height;
            }
            if (f.x < -wrapX) {
                f.x = width + wrapX * (0.4 + Math.random() * 0.6);
                f.y = Math.random() * height;
            }
            ctx.globalAlpha = f.o;
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        rafId = requestAnimationFrame(tick);
    }

    resize();
    if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(function () {
            resize();
        });
        resizeObserver.observe(section);
    } else {
        window.addEventListener('resize', resize);
    }

    rafId = requestAnimationFrame(tick);

    window.addEventListener(
        'pagehide',
        function onPageHide() {
            cancelAnimationFrame(rafId);
            if (resizeObserver) resizeObserver.disconnect();
            window.removeEventListener('resize', resize);
            window.removeEventListener('pagehide', onPageHide);
        },
        { once: true }
    );
}

/**
 * Scroll to document top.
 * @param {{ instant?: boolean }} [opts] - If instant is true, jump immediately (e.g. Home nav from Past talks). Otherwise smooth unless prefers-reduced-motion.
 */
function scrollHomeToTop(opts) {
    const instant = opts && opts.instant === true;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = instant || reduce ? 'auto' : 'smooth';
    window.scrollTo({ top: 0, left: 0, behavior });
}

/** Hide video/post viewer and collapse Past talks when returning to the home feed (same pattern as showBlogFeed). */
function collapseViewerAndPastTalksForHome() {
    const main = document.querySelector('.everything');
    if (!main) return;
    const viewerSection = main.querySelector(':scope > .viewer-section');
    if (viewerSection) {
        viewerSection.classList.add('is-collapsed');
        viewerSection.hidden = true;
        viewerSection.setAttribute('aria-hidden', 'true');
    }
    const pastSection = main.querySelector(':scope > .past-talks-section');
    if (pastSection) {
        pastSection.classList.add('is-collapsed');
        pastSection.hidden = true;
        pastSection.setAttribute('aria-hidden', 'true');
    }
}

/** Smooth scroll to home programme section (#home-programme-title; scroll-margin accounts for fixed nav). */
function scrollToHomeProgrammeSection() {
    const el =
        document.getElementById('home-programme-title') ||
        document.querySelector('.home-section > .programme-section');
    if (!el) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** Smooth scroll to home Event band (#home-location-heading). */
function scrollToHomeLocationSection() {
    const el =
        document.getElementById('home-location-heading') ||
        document.querySelector('.home-section .event-section');
    if (!el) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

/** Toggle collapsed-home state while Past talks section is open. */
function setPastTalksOpenState(isOpen) {
    document.body.classList.toggle('past-talks-open', !!isOpen);
    if (document.body.classList.contains('home-view')) {
        syncHomeViewNavbarFromScroll();
        if (!isOpen) {
            syncHomeNavSectionFromScroll();
        }
    }
    if (isOpen) {
        if (document.body.classList.contains('home-view')) {
            setupPastTalksPrussianStripSync();
        }
    } else {
        teardownPastTalksPrussianStripSync();
    }
}

/** Single img loaded/decoded (for staged home reveal). */
function waitForHomeImageDecode(img) {
    if (!img || !(img instanceof HTMLImageElement)) return Promise.resolve();
    // Any state where `complete` is true has already fired load or error — including 404/broken images
    // (`naturalWidth === 0`). Do not wait for events in that case or the Promise never resolves.
    if (img.complete) {
        return typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve();
    }
    return new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
    });
}

/** Waits for images under `root` to finish loading/decoding (bounded so bands do not stall for tens of seconds). */
async function waitForImagesInElementTree(root, timeoutMs) {
    if (!root) return;
    const ms = typeof timeoutMs === 'number' ? timeoutMs : 8000;
    const imgs = root.querySelectorAll('img');
    try {
        await withTimeout(
            Promise.all(Array.from(imgs).map((im) => waitForHomeImageDecode(im))),
            ms,
            'Section images'
        );
    } catch (e) {
        /* slow network / many assets — continue staged reveal */
    }
}

function waitForDoubleAnimationFrame() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

async function waitForHomePosterPictureReady(pictureEl) {
    if (!pictureEl) return;
    try {
        await withTimeout(
            (async function () {
                const main = pictureEl.querySelector('img.home-poster-wide') || pictureEl.querySelector('img');
                await waitForHomeImageDecode(main);
                const logo = pictureEl.querySelector('.mobile-poster-logo-img');
                await waitForHomeImageDecode(logo);
                await waitForDoubleAnimationFrame();
            })(),
            25000,
            'Home poster images'
        );
    } catch (e) {
        /* huge hero on slow links — still show rest of home */
    }
}

/** Home nav / logo: show feed if needed, then scroll to top. */
async function goToHomeFeed(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setActiveNavView('feed');
    setPastTalksOpenState(false);
    collapseViewerAndPastTalksForHome();
    if (document.body.classList.contains('home-view') && document.querySelector('.everything .home-section')) {
        scrollHomeToTop({ instant: true });
        syncHomeViewNavbarFromScroll();
        setTimeout(() => {
            monitorFeaturedTitleBreak();
        }, 100);
        return;
    }
    await showFeedContent();
    scrollHomeToTop({ instant: true });
    syncHomeViewNavbarFromScroll();
    setTimeout(() => {
        monitorFeaturedTitleBreak();
    }, 100);
}

/** Remove `.home-stage-hidden` from any node still inside `.home-section` (used when staged load throws). */
/** YouTube usually defers iframe loads inside `display:none`; assign src after Location is shown. */
function kickLocationTrailerEmbed(locationSectionEl) {
    if (!locationSectionEl) return;
    const iframe = locationSectionEl.querySelector('.trailer-embed iframe');
    if (!iframe) return;
    const url = iframe.getAttribute('data-embed-src') || iframe.getAttribute('src');
    if (!url || url === 'about:blank') return;
    iframe.src = '';
    iframe.src = url;
}

function revealStuckHomeStageBands(homeSection) {
    if (!homeSection) return;
    homeSection.querySelectorAll('.home-stage-hidden').forEach(function (el) {
        el.classList.remove('home-stage-hidden');
    });
    requestAnimationFrame(function () {
        kickLocationTrailerEmbed(homeSection.querySelector('.event-section'));
        layoutHomeSponsorLogosRowApply(homeSection.querySelector('.sponsors-section'));
    });
}

// Show the feed content (different from blog posts)
async function showFeedContent() {
    document.body.classList.add('home-view');
    setPastTalksOpenState(false);
    const main = document.querySelector('.everything');
    if (main) {
        teardownHomeViewNavbarScroll();
        
        setActiveNavView('feed');
        
        // No section title needed
        
        main.innerHTML = `
            <section class="home-section">
                <picture>
                    <source media="(max-width: 768px)" srcset="images/poster_narrow_q72.jpg">
                    <img src="images/poster_wide_q72.jpg" alt="" class="home-poster-wide" width="1920" height="1300" loading="eager" decoding="async" fetchpriority="high" onerror="this.onerror=null; this.src='images/poster_wide.png';">
                    <canvas class="poster-snow-canvas" aria-hidden="true"></canvas>
                    <div class="mobile-poster-logo" aria-hidden="true">
                        <img src="images/logo.png" alt="" class="mobile-poster-logo-img" loading="eager" decoding="async" onerror="this.style.display='none';">
                    </div>
                </picture>
                <div class="introslider-wrapper">
                    <div class="introslider">
                        ${FEATURED_ABOUT_SLIDER_HTML}
                        ${FEATURED_LOCATION_SLIDER_HTML}
                        ${FEATURED_ABOUT_SPEAKERS_SLIDER_HTML}
                        ${FEATURED_ABOUT_PROGRAMME_SLIDER_HTML}
                        ${FEATURED_PAST_TALKS_SLIDER_HTML}
                        ${FEATURED_REGISTER_SLIDER_HTML}
                </div>
                    <div class="home-introslider-scrollbar" aria-hidden="true">
                        <div class="home-introslider-scrollbar-track">
                            <div class="home-introslider-scrollbar-thumb"></div>
                        </div>
                    </div>
                    <div class="introslider-indicators" aria-label="Slider position">
                        <button type="button" class="introslider-dot" data-index="0" aria-label="Slide 1"></button>
                        <button type="button" class="introslider-dot" data-index="1" aria-label="Slide 2"></button>
                        <button type="button" class="introslider-dot" data-index="2" aria-label="Slide 3"></button>
                        <button type="button" class="introslider-dot" data-index="3" aria-label="Slide 4"></button>
                        <button type="button" class="introslider-dot" data-index="4" aria-label="Slide 5"></button>
                        <button type="button" class="introslider-dot" data-index="5" aria-label="Slide 6"></button>
                    </div>
                </div>
${HOME_LOCATION_SECTION_HTML}
${HOME_SPONSORS_SECTION_HTML}
                <div class="feed-section">
                    <div class="feed-section-inner-wrapper">
                    </div>
                </div>
${HOME_SPEAKERS_SLIDER_HTML}
${HOME_ONDEMAND_SECTION_HTML}
${HOME_REGISTRATION_OUTER_HTML}
            </section>
            <section class="past-talks-section is-collapsed" hidden aria-hidden="true"></section>
        `;

        const homeSection = main.querySelector('.home-section');
        setupRegistrationEmailConfirmValidation(homeSection);
        const pictureEl = homeSection && homeSection.querySelector(':scope > picture');
        const introWrap = homeSection && homeSection.querySelector(':scope > .introslider-wrapper');
        const feedWrap = homeSection && homeSection.querySelector(':scope > .feed-section');
        const eventSectionWrap = homeSection && homeSection.querySelector(':scope > .event-section');
        const sponsorsWrap = homeSection && homeSection.querySelector(':scope > .sponsors-section');
        const speakersWrap = homeSection && homeSection.querySelector(':scope > .speaker-section');
        const regWrap = homeSection && homeSection.querySelector(':scope > .registration-section');
        const ondemandWrap = homeSection && homeSection.querySelector(':scope > .ondemand-section');
        [introWrap, eventSectionWrap, feedWrap, sponsorsWrap, speakersWrap, ondemandWrap, regWrap].forEach((el) => {
            if (el) el.classList.add('home-stage-hidden');
        });

        await injectHomeEventInfoBodyHtml(homeSection);

        wireSliderIndicators();
        setupHomeViewNavbarScroll();
        
        // Past talks introslider panel → Past talks (video) view
        const pastTalksSlideEl = main.querySelector('.home-section .introslider > .pasttalks');
        if (pastTalksSlideEl) {
            pastTalksSlideEl.addEventListener('click', async function(e) {
                e.preventDefault();
                await showBlogFeed();
            });
        }

        const registerSlideEl = main.querySelector('.home-section .introslider > .register');
        if (registerSlideEl) {
            registerSlideEl.addEventListener('click', async function(e) {
                e.preventDefault();
                await goToHomeRegistration(null);
            });
        }

        const aboutProgrammeSlideEl = main.querySelector('.home-section .introslider > .about-programme');
        if (aboutProgrammeSlideEl) {
            aboutProgrammeSlideEl.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                scrollToHomeProgrammeSection();
            });
            aboutProgrammeSlideEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    scrollToHomeProgrammeSection();
                }
            });
        }
        const locationSlideEl = main.querySelector('.home-section .introslider > .location');
        if (locationSlideEl) {
            locationSlideEl.addEventListener('click', function(e) {
                if (e.target.closest('a')) return;
                e.preventDefault();
                void goToHomeLocation(e);
            });
            locationSlideEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void goToHomeLocation(e);
                }
            });
        }
        const aboutSpeakersSlideEl = main.querySelector('.home-section .introslider > .about-speakers');
        if (aboutSpeakersSlideEl) {
            aboutSpeakersSlideEl.addEventListener('click', function(e) {
                void goToHomeSpeakers(e);
            });
            aboutSpeakersSlideEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    void goToHomeSpeakers(e);
                }
            });
        }

        try {
            await waitForHomePosterPictureReady(pictureEl);
            if (introWrap) introWrap.classList.remove('home-stage-hidden');
            setupHomeHeroIntrosliderPosterGap(8);
            requestAnimationFrame(function () {
                initPosterSnow();
            });

            // Start heavy data work immediately so it runs in parallel with intro image settling.
            const newsFeedPromise = loadNewsFeed();
            const speakersPromise = speakersWrap ? populateHomeSpeakersSliderFromFirebase(speakersWrap) : Promise.resolve();
            const registrationManifestoPromise = regWrap
                ? fetchHomeRegistrationManifestoFromFirebase()
                : Promise.resolve('');

            const results = await Promise.all([newsFeedPromise, speakersPromise, registrationManifestoPromise]);
            const registrationManifestoHtml = results && results.length >= 3 ? results[2] : '';

            const programmeWrap = homeSection && homeSection.querySelector(':scope > .programme-section');
            if (eventSectionWrap) {
                eventSectionWrap.classList.remove('home-stage-hidden');
                requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                        kickLocationTrailerEmbed(eventSectionWrap);
                    });
                });
            }
            if (sponsorsWrap) {
                sponsorsWrap.classList.remove('home-stage-hidden');
            }
            if (feedWrap) feedWrap.classList.remove('home-stage-hidden');
            if (speakersWrap) speakersWrap.classList.remove('home-stage-hidden');
            if (programmeWrap) programmeWrap.classList.remove('home-stage-hidden');
            if (ondemandWrap) ondemandWrap.classList.remove('home-stage-hidden');

            if (regWrap) regWrap.classList.remove('home-stage-hidden');
            if (regWrap) {
                const manifestoEl = regWrap.querySelector('p.registration-manifesto');
                if (manifestoEl && typeof registrationManifestoHtml === 'string') {
                    manifestoEl.innerHTML = registrationManifestoHtml;
                }
            }

            requestAnimationFrame(function () {
                wireHomeSponsorLogosRowLayout(sponsorsWrap);
                syncHomeNavSectionFromScroll();
            });
        } finally {
            revealStuckHomeStageBands(homeSection);
            requestAnimationFrame(() => {
                syncHomeNavSectionFromScroll();
            });
        }
    }
}

/** Register nav / introslider Register slide: load home (if needed) and smooth-scroll to the Registration title. */
async function goToHomeRegistration(e) {
    if (e) e.preventDefault();
    setPastTalksOpenState(false);
    if (!document.body.classList.contains('home-view')) {
        await showFeedContent();
    }
    setActiveNavView('register');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const el = document.getElementById('home-registration-heading');
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

/** Introslider Location panel / scroll target: home Location band title. */
async function goToHomeLocation(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setPastTalksOpenState(false);
    if (!document.body.classList.contains('home-view')) {
        await showFeedContent();
    }
    setActiveNavView('feed');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const el = document.getElementById('home-location-heading');
            if (!el) return;
            const reduce =
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        });
    });
}

/** Programme nav: load home (if needed) and smooth-scroll to the Programme section title. */
async function goToHomeProgramme(e) {
    if (e) e.preventDefault();
    setPastTalksOpenState(false);
    if (!document.body.classList.contains('home-view')) {
        await showFeedContent();
    }
    setActiveNavView('flyer');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const el = document.getElementById('home-programme-title');
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

/** Speakers nav / introslider Speakers slide: load home (if needed) and smooth-scroll to the Speakers row. */
async function goToHomeSpeakers(e) {
    if (e) e.preventDefault();
    setPastTalksOpenState(false);
    if (!document.body.classList.contains('home-view')) {
        await showFeedContent();
    }
    setActiveNavView('speakers');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const el = document.getElementById('speakers-section');
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
}

// Load and display news feed
async function loadNewsFeed() {
    const feedContent = document.querySelector('.feed-section-inner-wrapper');
    if (!feedContent) {
        console.error('feedContent element not found');
        return;
    }
    
    // Show loading state
    showFeedLoadingState();
    
    try {
        // Use shared fetch function with caching
        const newsRecords = await fetchNewsFeed();
        
        // Use only real data
        let allRecords = [];
        if (newsRecords.length > 0) {
            // Separate shouts first
            const shouts = newsRecords.filter(record => {
                const t = record.fields.Type ? record.fields.Type.toLowerCase().trim() : '';
                return t === 'shout';
            });
            // Exclude shorts and shouts from the main feed
            const filteredRecords = newsRecords.filter(record => {
                const type = record.fields.Type ? record.fields.Type.toLowerCase().trim() : '';
                return type !== 'short' && type !== 'shouts' && type !== 'shout';
            });
            const sortedRealRecords = filteredRecords
                .sort((a, b) => new Date(b.fields.Date || b.createdTime) - new Date(a.fields.Date || a.createdTime));
            // Deduplicate by document id (same row can't appear twice)
            const seenIds = new Set();
            const uniqueById = sortedRealRecords.filter(r => {
                if (seenIds.has(r.id)) return false;
                seenIds.add(r.id);
                return true;
            });
            // Deduplicate by YouTube video ID so the same video (e.g. "Prolonged field care") from two rows only shows once
            const extractYouTubeId = (record) => {
                const url = record.fields?.URL || record.fields?.['YouTube URL'] || record.fields?.Link || '';
                if (!url) return null;
                const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/);
                return m ? m[1] : null;
            };
            const seenYouTubeIds = new Set();
            allRecords = uniqueById.filter(r => {
                const ytId = extractYouTubeId(r);
                if (!ytId) return true; // non-video or no URL: keep
                if (seenYouTubeIds.has(ytId)) return false;
                seenYouTubeIds.add(ytId);
                return true;
            });

            // Render shouts into shoutbox
            renderShoutbox(shouts);
        }
        
        window.allContentRecords = allRecords;

        if (allRecords.length === 0) {
            const feedContent = document.querySelector('.feed-section-inner-wrapper');
            if (feedContent) {
                feedContent.innerHTML = '<div class="empty-feed-message">No content available at this time.</div>';
            } else {
                console.error('feedContent element not found when trying to show empty message');
            }
            return;
        }
        
        // Extract video data directly from cached records (no additional API calls needed)
        const videoDataMap = {};
        allRecords.forEach(record => {
            if (isVideoOrEditType(record.fields.Type) && record.fields.URL) {
                // Use the record data directly instead of making another API call
                videoDataMap[record.id] = {
                    url: record.fields.URL,
                    title: record.fields.Title || record.fields.Name,
                    thumbnail: record.fields.Thumbnail || record.fields.Image,
                    duration: record.fields.Duration,
                    views: record.fields.Views
                };
            }
        });
        
        // Store video data map globally for use in createNewsCard
        window.videoDataMap = videoDataMap;
        
        window.allContentRecords = allRecords;
        window.allNewsRecords = allRecords;

        await displayNewsGrid(orderHomeFeedWithFeaturedFirst(allRecords));
        
    } catch (error) {
        console.error('Error loading news feed:', error);
        // Show error message instead of redirecting
        const feedContent = document.querySelector('.feed-section-inner-wrapper');
        if (feedContent) {
            feedContent.innerHTML = `
                <div class="empty-feed-message">
                    <p>Unable to load news feed. Please try refreshing the page.</p>
                    <p style="font-size: 0.9em; color: #666; margin-top: 0.5rem;">Error: ${error.message}</p>
                </div>
            `;
        } else {
            console.error('feedContent element not found - cannot display error message');
        }
    }
}

// Show fallback content when feed source is offline
async function showFallbackNewsContent() {
    const feedContent = document.querySelector('.feed-section-inner-wrapper');
    if (!feedContent) {
        console.error('feedContent element not found for fallback');
        return;
    }
    
    // Create fallback news items
    const fallbackNews = [
        {
            id: 'fallback-1',
            fields: {
                Name: 'TBS26 Conference Updates',
                Type: 'news',
                Published: 'Yes',
                Content: 'Stay tuned for the latest updates about TBS26. We\'re working on bringing you the most current information about our upcoming conference.',
                Image: 'images/background.jpg',
                Date: new Date().toISOString()
            }
        },
        {
            id: 'fallback-2', 
            fields: {
                Name: 'Critical Care Education',
                Type: 'news',
                Published: 'Yes',
                Content: 'TBS continues to be at the forefront of critical care education, bringing together leading experts in emergency medicine.',
                Image: 'images/background.jpg',
                Date: new Date(Date.now() - 86400000).toISOString() // Yesterday
            }
        },
        {
            id: 'fallback-3',
            fields: {
                Name: 'Zermatt Venue Information',
                Type: 'news',
                Published: 'Yes',
                Content: 'Our beautiful venue in Zermatt provides the perfect setting for intensive learning and networking in critical care medicine.',
                Image: 'images/background.jpg',
                Date: new Date(Date.now() - 172800000).toISOString() // 2 days ago
            }
        },
        {
            id: 'fallback-4',
            fields: {
                Name: 'Speaker Announcements',
                Type: 'news',
                Published: 'Yes',
                Content: 'We\'re excited to announce our lineup of world-class speakers for TBS26. More details coming soon.',
                Image: 'images/background.jpg', 
                Date: new Date(Date.now() - 259200000).toISOString() // 3 days ago
            }
        }
    ];
    
    // Set global variables for consistency
    window.allNewsRecords = fallbackNews;
    window.videoDataMap = {};
    
    // Display the fallback content
    await displayNewsGrid(fallbackNews);
    
    // Add a notice that we're showing cached/fallback content
    const notice = document.createElement('div');
    notice.style.cssText = `
        background: #fff3cd;
        border: 1px solid #ffeaa7;
        color: #856404;
        padding: 12px 20px;
        margin: 20px auto;
        max-width: 1200px;
        border-radius: 8px;
        text-align: center;
        font-size: 14px;
    `;
    notice.innerHTML = '📡 <strong>Service Notice:</strong> We\'re currently experiencing connectivity issues with our content provider. Showing cached content.';
    
    // Insert notice at the top of the feed
    const feedGrid = feedContent.querySelector('.feed-grid');
    if (feedGrid && feedGrid.parentNode) {
        feedGrid.parentNode.insertBefore(notice, feedGrid);
    }
}

const HOME_FEED_INITIAL_COUNT = 5;
const HOME_FEED_PAGE_SIZE = 5;

// Show loading state for feed
function showFeedLoadingState() {
    const feedContent = document.querySelector('.feed-section-inner-wrapper');
    if (!feedContent) {
        console.error('showFeedLoadingState - feedContent not found');
        return;
    }
    
    feedContent.innerHTML = `
        <div class="feed-loading">
            <div class="loading-spinner"></div>
            <p>Loading news feed...</p>
        </div>
        <div class="skeleton-cards">
            ${Array.from({length: HOME_FEED_INITIAL_COUNT}, () => `
                <div class="skeleton-card">
                    <div class="skeleton-image"></div>
                    <div class="skeleton-content">
                        <div class="skeleton-title"></div>
                        <div class="skeleton-text"></div>
                        <div class="skeleton-text short"></div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

async function appendNewsCardsToGrid(newsGrid, recordsSlice) {
    const cardPromises = recordsSlice.map((record) => createNewsCard(record));
    const newsCards = (await Promise.all(cardPromises)).filter(Boolean);
    newsCards.forEach((card) => newsGrid.appendChild(card));
}

function attachHomeFeedLoadMore(feedContent, newsGrid, validRecords) {
    feedContent.querySelectorAll('.feed-latest-chevron-row').forEach(function (el) {
        el.remove();
    });
    feedContent.querySelectorAll('.feed-load-more-btn, .feed-load-less-btn').forEach((el) => el.remove());

    let shownCount = Math.min(HOME_FEED_INITIAL_COUNT, validRecords.length);
    if (shownCount >= validRecords.length) return;

    const row = document.createElement('div');
    row.className = 'feed-latest-chevron-row';

    function syncChevronControls() {
        row.remove();
        const cards = newsGrid.querySelectorAll(':scope > .news-card');
        cards.forEach(function (card, index) {
            const ctl = card.querySelector('.news-card-controls');
            if (!ctl) return;
            ctl.innerHTML = '';
            const isLast = index === cards.length - 1;
            if (!isLast) {
                ctl.classList.add('news-card-controls--collapsed');
                ctl.setAttribute('aria-hidden', 'true');
                return;
            }
            ctl.classList.remove('news-card-controls--collapsed');
            ctl.setAttribute('aria-hidden', 'false');
            ctl.appendChild(row);
        });
    }

    function syncChevronButtons() {
        row.replaceChildren();
        if (shownCount > HOME_FEED_INITIAL_COUNT) {
            const lessBtn = document.createElement('button');
            lessBtn.type = 'button';
            lessBtn.className = 'feed-load-less-btn';
            lessBtn.setAttribute('aria-label', 'Show only the first ' + HOME_FEED_INITIAL_COUNT + ' items');
            lessBtn.innerHTML = UI_CHEVRON_UP_SVG;
            lessBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                while (newsGrid.children.length > HOME_FEED_INITIAL_COUNT) {
                    newsGrid.removeChild(newsGrid.lastChild);
                }
                shownCount = HOME_FEED_INITIAL_COUNT;
                syncChevronButtons();
                const latestHeading = document.getElementById('home-feed-latest-heading');
                if (latestHeading) {
                    latestHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
            row.appendChild(lessBtn);
        }
        if (shownCount < validRecords.length) {
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.className = 'feed-load-more-btn';
            moreBtn.setAttribute('aria-label', 'Load more');
            moreBtn.innerHTML = UI_CHEVRON_DOWN_SVG;
            moreBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();
                moreBtn.disabled = true;
                try {
                    const next = validRecords.slice(shownCount, shownCount + HOME_FEED_PAGE_SIZE);
                    shownCount += next.length;
                    await appendNewsCardsToGrid(newsGrid, next);
                } finally {
                    moreBtn.disabled = false;
                    syncChevronButtons();
                }
            });
            row.appendChild(moreBtn);
        }
        syncChevronControls();
    }

    syncChevronButtons();
}

/** Order and markup for home programme slider; lives in index.html #programme-index-source */
const PROGRAMME_INDEX_DAY_ORDER = ['tuesday', 'wednesday', 'thursday', 'friday'];

/** Same prefix as backend.html text editor (localStorage per programme day). */
const TBS_TEXTEDITOR_PROGRAMME_LS_PREFIX = 'tbsBackend:texteditor:programme:';

/** Home Location band: localStorage key (backend editor / cross-tab); Firestore `events/{id}` field `locationinfo` is preferred on load. */
const TBS_TEXTEDITOR_HOME_LOCATION_LS_KEY = 'tbsBackend:texteditor:home:location-text';

/** Default copy for the home Location band (left column) when Firestore and localStorage are empty. */
const HOME_LOCATION_BAND_DEFAULT_HTML = `<p>Getting to Zermatt is fairly straightforward. Those of you travelling from abroad are likely to come in through Geneva or Zurich airports. From there you simply take the train, via Visp, to get to Zermatt.</p><p>The four-star <a href="${TBS_HOTEL_ALEX_URL}" target="_blank" rel="noopener noreferrer">Hotel Alex</a> is the venue and the heart of the event. It is only a minute's walk from the Zermatt railway station.</p><p>All lecture sessions will be held in the Alex main conference facility. With the exception of the occasional off-site session, most workshops happen here as well.</p>`;

/** Event id used for home page reads that still live under `events/{id}` (speakers row, location, etc.). */
const TBS27_HOME_PROGRAMME_EVENT_ID = 'TBS27';
/** First home speaker card HTML: Firestore `tbs/snippets` field `Speakers`. */
const HOME_SNIPPETS_SPEAKERS_FIELD = 'Speakers';
/** Home registration manifesto HTML: Firestore `tbs/Snippets` field `Registration`. */
const HOME_SNIPPETS_TEGISTRATION_FIELD = 'Registration';
/** Home Location body HTML: Firestore `events/{eventId}` field `locationinfo` (same as backend Snippets → Location save). */
const HOME_EVENT_LOCATIONINFO_FIELD = 'locationinfo';
/** Home `.event-contents` HTML: Firestore `tbs/Snippets` field `Eventinfo`. */
const HOME_SNIPPETS_EVENTINFO_FIELD = 'Eventinfo';
/** First programme slider card body: Firestore `tbs/Snippets` field `Programmeinfo` (backend Snippets → Programme intro). */
const HOME_SNIPPETS_PROGRAMMEINFO_FIELD = 'Programmeinfo';
/** localStorage key for Programme intro snippet (must match backend `data-snippet-key`). */
const TBS_TEXTEDITOR_HOME_PROGRAMMEINFO_LS_KEY = 'tbsBackend:texteditor:home:programmeinfo';
/** ISO date per slider day card; `html` is read from `tbs/Programme/{ISO}/Programme` (same as backend Snippets). */
const HOME_PROGRAMME_FIREBASE_DATE_BY_DAY = {
    tuesday: '2027-02-09',
    wednesday: '2027-02-10',
    thursday: '2027-02-11',
    /** Friday day card: `tbs/Programme/2027-02-12/Programme` field `html`. */
    friday: '2027-02-12'
};

/**
 * Ensures one slide = one flex child of .programme-slider with .programme-{day} card styles.
 * Raw HTML with several top-level nodes would each become a column (side by side). Missing
 * the outer .programme-* wrapper loses white background / shadow on the card.
 * @param {string} dayKey e.g. 'tuesday'
 * @param {string} htmlString
 * @returns {string}
 */
function normalizeProgrammeSlideHtml(dayKey, htmlString) {
    const t = (htmlString || '').trim();
    if (!t) return '';
    const dayClass = 'programme-' + dayKey;
    let doc;
    try {
        doc = new DOMParser().parseFromString(t, 'text/html');
    } catch (e) {
        return wrapProgrammeSlideCard(dayKey, t);
    }
    const body = doc.body;
    if (body.children.length === 1) {
        const el = body.children[0];
        if (el.classList && el.classList.contains(dayClass)) {
            return el.outerHTML;
        }
    }
    return wrapProgrammeSlideCard(dayKey, body.innerHTML.trim());
}

function wrapProgrammeSlideCard(dayKey, innerHtml) {
    return (
        '<div class="programme-' +
        dayKey +
        '">' +
        '<div class="programme-day-content programmestyle">' +
        innerHtml +
        '</div>' +
        '</div>'
    );
}

/**
 * Reads programme **day** slide HTML (Tuesday–Friday cards, not the intro card) from Firestore.
 * Path: `tbs/Programme/{ISO-date}/Programme` field `html`.
 * @returns {Promise<string>} HTML string or '' if missing / offline / error.
 */
async function fetchHomeProgrammeDayHtmlFromFirebase(dayKey) {
    const isoDate = HOME_PROGRAMME_FIREBASE_DATE_BY_DAY[dayKey];
    if (!isoDate || typeof firebase === 'undefined') return '';
    const cached = firestoreHomeCache.programmeDayByIsoDate.get(isoDate);
    if (isFreshFirestoreCacheEntry(cached)) return cached.value || '';
    if (cached && cached.promise) return cached.promise;
    const promise = (async function () {
    try {
        const db = getFirestore();
        const tbsSnap = await withTimeout(
            db.collection('tbs').doc('Programme').collection(isoDate).doc('Programme').get(),
            10000,
            'Firestore tbs/Programme/{date}/Programme html'
        );
        if (!tbsSnap.exists) return '';
        const tbsData = tbsSnap.data() || {};
        const fromTbs = tbsData.html != null ? String(tbsData.html).trim() : '';
        return fromTbs;
    } catch (e) {
        console.error('fetchHomeProgrammeDayHtmlFromFirebase', dayKey, e);
        return '';
    }
    })();
    firestoreHomeCache.programmeDayByIsoDate.set(isoDate, {
        value: cached ? cached.value : '',
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    });
    const value = await promise;
    firestoreHomeCache.programmeDayByIsoDate.set(isoDate, {
        value: value || '',
        fetchedAt: Date.now(),
        promise: null
    });
    return value || '';
}

function normalizeProgrammeInfoSlideHtml(htmlString) {
    const t = (htmlString || '').trim();
    if (!t) return '';
    try {
        const doc = new DOMParser().parseFromString(t, 'text/html');
        const body = doc.body;
        if (body.children.length === 1) {
            const el = body.children[0];
            if (el.classList && el.classList.contains('programme-info')) {
                return el.outerHTML;
            }
        }
        return '<div class="programme-info programme-friday"><div class="programme-day-content programmestyle">' + body.innerHTML.trim() + '</div></div>';
    } catch (e) {
        return '<div class="programme-info programme-friday"><div class="programme-day-content programmestyle">' + t + '</div></div>';
    }
}

/** Same ordering as backend speaker roster (first name, then last name, then doc id). */
function compareHomeSpeakersForSort(a, b) {
    const fa = String(a.firstName || '').trim().toLowerCase();
    const fb = String(b.firstName || '').trim().toLowerCase();
    let c = fa.localeCompare(fb);
    if (c !== 0) return c;
    const la = String(a.lastName || '').trim().toLowerCase();
    const lb = String(b.lastName || '').trim().toLowerCase();
    c = la.localeCompare(lb);
    if (c !== 0) return c;
    return String(a.id).localeCompare(String(b.id));
}

function normalizeHomeSpeakerBioPublish(v) {
    const s = v != null ? String(v).trim().toLowerCase() : '';
    if (!s) return 'No';
    if (s === 'yes' || s === 'true' || s === '1') return 'Yes';
    return 'No';
}

function homeSpeakerIdsFromTbsParentData(data) {
    if (!data || typeof data !== 'object') return [];
    const arrayKeys = ['speakerIds', 'rowIds', 'ids', 'order', 'speakerOrder', 'documents'];
    for (let i = 0; i < arrayKeys.length; i++) {
        const v = data[arrayKeys[i]];
        if (!Array.isArray(v) || !v.length) continue;
        const out = v
            .map((x) => String(x != null ? x : '').trim())
            .filter(Boolean);
        if (out.length) return out;
    }
    return [];
}

/**
 * @returns {Promise<Array<{ id: string, firstName: string, lastName: string, shortBio: string, longBio: string }>>}
 */
async function fetchHomeSpeakersListFromFirebase(eventId) {
    if (typeof firebase === 'undefined') return [];
    const cacheKey = eventId || '__tbs_speakers__';
    const cached = firestoreHomeCache.speakersByEventId.get(cacheKey);
    if (isFreshFirestoreCacheEntry(cached)) return Array.isArray(cached.value) ? cached.value : [];
    if (cached && cached.promise) return cached.promise;
    const promise = (async function () {
    try {
        const db = getFirestore();
        const parentSnap = await withTimeout(
            db.collection('tbs').doc('Speakers').get(),
            10000,
            'Firestore tbs/Speakers parent'
        );
        const parentData = parentSnap && parentSnap.exists ? (parentSnap.data() || {}) : {};
        const ids = homeSpeakerIdsFromTbsParentData(parentData);
        if (!ids.length) return [];
        const list = [];
        const chunkSize = 12;
        for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const snaps = await Promise.all(
                chunk.map((rowId) => withTimeout(
                    db.collection('tbs').doc('Speakers').collection(rowId).doc('item').get(),
                    10000,
                    'Firestore tbs/Speakers/{id}/item'
                ))
            );
            for (let j = 0; j < chunk.length; j++) {
                const rowId = chunk[j];
                const docSnap = snaps[j];
                if (!docSnap || !docSnap.exists) continue;
                const d = docSnap.data() || {};
                const bioPublishRaw = d.biopublish != null
                    ? d.biopublish
                    : (d.BioPublish != null ? d.BioPublish : d['Bio publish']);
                if (normalizeHomeSpeakerBioPublish(bioPublishRaw) !== 'Yes') continue;
                list.push({
                    id: rowId,
                    firstName: d['First Name'] != null ? String(d['First Name']) : (d.firstName != null ? String(d.firstName) : ''),
                    lastName: d['Last name'] != null ? String(d['Last name']) : (d.lastName != null ? String(d.lastName) : ''),
                    shortBio: '',
                    longBio: d.Bio_long != null ? String(d.Bio_long) : (d.longBio != null ? String(d.longBio) : '')
                });
            }
        }
        list.sort(compareHomeSpeakersForSort);
        return list;
    } catch (e) {
        console.error('fetchHomeSpeakersListFromFirebase', e);
        return [];
    }
    })();
    firestoreHomeCache.speakersByEventId.set(cacheKey, {
        value: cached && Array.isArray(cached.value) ? cached.value : [],
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    });
    const value = await promise;
    firestoreHomeCache.speakersByEventId.set(cacheKey, {
        value: Array.isArray(value) ? value : [],
        fetchedAt: Date.now(),
        promise: null
    });
    return Array.isArray(value) ? value : [];
}

/** HTML for first slider card from `tbs/snippets` field `Speakers`. */
async function fetchHomeEventSpeakerInfoFromFirebase(eventId) {
    if (typeof firebase === 'undefined') return '';
    const cached = firestoreHomeCache.speakerInfoByEventId.get(eventId);
    if (isFreshFirestoreCacheEntry(cached)) return typeof cached.value === 'string' ? cached.value : '';
    if (cached && cached.promise) return cached.promise;
    const promise = (async function () {
        try {
            const db = getFirestore();
            const snap = await withTimeout(
                db.collection('tbs').doc('Snippets').get(),
                10000,
                'Firestore tbs/Snippets Speakers'
            );
            const data = snap.exists ? snap.data() || {} : {};
            const raw = data[HOME_SNIPPETS_SPEAKERS_FIELD] != null
                ? data[HOME_SNIPPETS_SPEAKERS_FIELD]
                : (data.speakers != null ? data.speakers : data.speakerinfo);
            const fromSnippets = raw != null ? String(raw) : '';
            if (String(fromSnippets).trim() !== '') return fromSnippets;
            const eventSnap = await withTimeout(
                db.collection('events').doc(TBS27_HOME_PROGRAMME_EVENT_ID).get(),
                10000,
                'Firestore events/TBS27 speakerinfo fallback'
            );
            const eventData = eventSnap.exists ? eventSnap.data() || {} : {};
            const fallback = eventData.speakerinfo != null ? String(eventData.speakerinfo) : '';
            return fallback;
        } catch (e) {
            console.warn('[home snippets Speakers]', e);
            return '';
        }
    })();
    firestoreHomeCache.speakerInfoByEventId.set(eventId, {
        value: cached && typeof cached.value === 'string' ? cached.value : '',
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    });
    const value = await promise;
    firestoreHomeCache.speakerInfoByEventId.set(eventId, {
        value: typeof value === 'string' ? value : '',
        fetchedAt: Date.now(),
        promise: null
    });
    return typeof value === 'string' ? value : '';
}

/** HTML for `.registration-manifesto` from `tbs/Snippets` field `Registration`. */
async function fetchHomeRegistrationManifestoFromFirebase() {
    if (typeof firebase === 'undefined') return '';
    const cached = firestoreHomeCache.registrationManifesto;
    if (isFreshFirestoreCacheEntry(cached)) {
        return typeof cached.value === 'string' ? cached.value : '';
    }
    if (cached && cached.promise) return cached.promise;

    const promise = (async function () {
        try {
            const db = getFirestore();
            const snap = await withTimeout(
                db.collection('tbs').doc('Snippets').get(),
                10000,
                'Firestore tbs/Snippets Registration'
            );
            const data = snap.exists ? snap.data() || {} : {};
            const raw = data[HOME_SNIPPETS_TEGISTRATION_FIELD] != null ? data[HOME_SNIPPETS_TEGISTRATION_FIELD] : '';
            return raw != null ? String(raw) : '';
        } catch (e) {
            console.warn('[home snippets Registration]', e);
            return '';
        }
    })();

    firestoreHomeCache.registrationManifesto = {
        value: cached && typeof cached.value === 'string' ? cached.value : '',
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    };

    const value = await promise;
    firestoreHomeCache.registrationManifesto = {
        value: typeof value === 'string' ? value : '',
        fetchedAt: Date.now(),
        promise: null
    };
    return typeof value === 'string' ? value : '';
}

/** HTML for the first programme-band slider card from `tbs/Snippets` field `Programmeinfo`. */
async function fetchHomeProgrammeBandIntroFromSnippets() {
    if (typeof firebase === 'undefined') return '';
    const cached = firestoreHomeCache.programmeBandIntroSnippets;
    if (isFreshFirestoreCacheEntry(cached)) {
        return typeof cached.value === 'string' ? cached.value : '';
    }
    if (cached && cached.promise) return cached.promise;

    const promise = (async function () {
        try {
            const db = getFirestore();
            const snap = await withTimeout(
                db.collection('tbs').doc('Snippets').get(),
                10000,
                'Firestore tbs/Snippets Programmeinfo'
            );
            const data = snap.exists ? snap.data() || {} : {};
            const raw = data[HOME_SNIPPETS_PROGRAMMEINFO_FIELD] != null ? data[HOME_SNIPPETS_PROGRAMMEINFO_FIELD] : '';
            return raw != null ? String(raw) : '';
        } catch (e) {
            console.warn('[home snippets Programmeinfo]', e);
            return '';
        }
    })();

    firestoreHomeCache.programmeBandIntroSnippets = {
        value: cached && typeof cached.value === 'string' ? cached.value : '',
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    };

    const value = await promise;
    firestoreHomeCache.programmeBandIntroSnippets = {
        value: typeof value === 'string' ? value : '',
        fetchedAt: Date.now(),
        promise: null
    };
    return typeof value === 'string' ? value : '';
}

/** HTML for `.location-text-body` from `events/{eventId}` field `locationinfo`. */
async function fetchHomeEventLocationInfoFromFirebase(eventId) {
    if (!eventId || typeof firebase === 'undefined') return '';
    const cached = firestoreHomeCache.locationInfoByEventId.get(eventId);
    if (isFreshFirestoreCacheEntry(cached)) return typeof cached.value === 'string' ? cached.value : '';
    if (cached && cached.promise) return cached.promise;
    const promise = (async function () {
        try {
            const db = getFirestore();
            const snap = await withTimeout(
                db.collection('events').doc(eventId).get(),
                10000,
                'Firestore event locationinfo'
            );
            const data = snap.exists ? snap.data() || {} : {};
            const raw = data[HOME_EVENT_LOCATIONINFO_FIELD];
            return raw != null ? String(raw) : '';
        } catch (e) {
            console.warn('[home locationinfo]', e);
            return '';
        }
    })();
    firestoreHomeCache.locationInfoByEventId.set(eventId, {
        value: cached && typeof cached.value === 'string' ? cached.value : '',
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    });
    const value = await promise;
    firestoreHomeCache.locationInfoByEventId.set(eventId, {
        value: typeof value === 'string' ? value : '',
        fetchedAt: Date.now(),
        promise: null
    });
    return typeof value === 'string' ? value : '';
}

/** HTML for home `.event-contents` from `tbs/Snippets` field `Eventinfo` (legacy: same-doc `eventinfo`, then `events/{eventId}.eventinfo`). */
async function fetchHomeEventEventInfoFromFirebase(eventId) {
    if (!eventId || typeof firebase === 'undefined') return '';
    const cached = firestoreHomeCache.eventInfoByEventId.get(eventId);
    if (isFreshFirestoreCacheEntry(cached)) return typeof cached.value === 'string' ? cached.value : '';
    if (cached && cached.promise) return cached.promise;
    const promise = (async function () {
        try {
            const db = getFirestore();
            const snap = await withTimeout(
                db.collection('tbs').doc('Snippets').get(),
                10000,
                'Firestore tbs/Snippets Eventinfo'
            );
            const data = snap.exists ? snap.data() || {} : {};
            let raw = data[HOME_SNIPPETS_EVENTINFO_FIELD];
            if (raw == null || String(raw).trim() === '') {
                raw = data.eventinfo != null ? data.eventinfo : '';
            }
            if (raw != null && String(raw).trim() !== '') {
                return String(raw);
            }
            const legacySnap = await withTimeout(
                db.collection('events').doc(eventId).get(),
                10000,
                'Firestore events legacy eventinfo'
            );
            const legacyData = legacySnap.exists ? legacySnap.data() || {} : {};
            const legacyRaw = legacyData.eventinfo != null ? legacyData.eventinfo : '';
            return legacyRaw != null ? String(legacyRaw) : '';
        } catch (e) {
            console.warn('[home snippets Eventinfo]', e);
            return '';
        }
    })();
    firestoreHomeCache.eventInfoByEventId.set(eventId, {
        value: cached && typeof cached.value === 'string' ? cached.value : '',
        fetchedAt: cached ? Number(cached.fetchedAt || 0) : 0,
        promise: promise
    });
    const value = await promise;
    firestoreHomeCache.eventInfoByEventId.set(eventId, {
        value: typeof value === 'string' ? value : '',
        fetchedAt: Date.now(),
        promise: null
    });
    return typeof value === 'string' ? value : '';
}

/**
 * Fills `.event-contents` from Firestore `tbs/Snippets.Eventinfo` (empty when missing).
 * @param {ParentNode | null | undefined} homeSectionRoot
 */
async function injectHomeEventInfoBodyHtml(homeSectionRoot) {
    const el = homeSectionRoot && homeSectionRoot.querySelector('.event-contents');
    if (!el) return;
    let fromCloud = '';
    try {
        fromCloud = await fetchHomeEventEventInfoFromFirebase(TBS27_HOME_PROGRAMME_EVENT_ID);
    } catch (e) {
        console.warn('Home eventinfo Firestore read failed:', e);
    }
    el.innerHTML = String(fromCloud).trim() !== '' ? fromCloud : '';
}

/**
 * Fills `.location-text-body` inside `.location-contents`: Firestore `locationinfo` first, then localStorage snippet, then default HTML.
 * @param {ParentNode | null | undefined} homeSectionRoot
 */
async function injectHomeLocationBodyHtml(homeSectionRoot) {
    const el = homeSectionRoot && homeSectionRoot.querySelector('.location-text-body');
    if (!el) return;
    let fromCloud = '';
    try {
        fromCloud = await fetchHomeEventLocationInfoFromFirebase(TBS27_HOME_PROGRAMME_EVENT_ID);
    } catch (e) {
        console.warn('Home location Firestore read failed:', e);
    }
    if (String(fromCloud).trim() !== '') {
        el.innerHTML = fromCloud;
        return;
    }
    try {
        const raw = localStorage.getItem(TBS_TEXTEDITOR_HOME_LOCATION_LS_KEY);
        if (raw != null && String(raw).trim() !== '') {
            el.innerHTML = raw;
            return;
        }
    } catch (e) {
        console.warn('Home location localStorage read failed:', e);
    }
    el.innerHTML = HOME_LOCATION_BAND_DEFAULT_HTML;
}

function appendHomeSpeakerPlaceholder(track, message) {
    const el = document.createElement('div');
    el.className = 'speaker-placeholder';
    el.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.className = 'speaker-placeholder-label';
    span.textContent = message;
    el.appendChild(span);
    track.appendChild(el);
}

/** Slide that only shows HTML from `events/{id}` field `speakerinfo` (always before real speaker cards). */
function appendHomeSpeakerinfoCard(track, html) {
    const article = document.createElement('article');
    article.className = 'speaker-card speaker-card--speakerinfo';
    article.setAttribute('aria-label', 'Speaker information');

    const innerWrap = document.createElement('div');
    innerWrap.className = 'speaker-card-inner-wrapper';
    const contentWrap = document.createElement('div');
    contentWrap.className = 'speaker-content';
    const bioEl = document.createElement('div');
    bioEl.className = 'speaker-card-bio about-text';
    const bioMain = document.createElement('div');
    bioMain.className = 'speaker-card-bio-main';
    bioMain.innerHTML = html != null ? String(html) : '';
    bioEl.appendChild(bioMain);

    contentWrap.appendChild(bioEl);
    innerWrap.appendChild(contentWrap);

    article.appendChild(innerWrap);
    track.appendChild(article);
}

/**
 * @param {boolean} expandableLongBio — same rule as former per-card chevron: first real speaker when there is no
 * `speakerinfo` card has no long-bio expand. Cards with this flag toggle short/long bio on press.
 */
function appendHomeSpeakerCard(track, speaker, expandableLongBio) {
    const article = document.createElement('article');
    article.className = 'speaker-card';
    const name =
        `${String(speaker.firstName || '').trim()} ${String(speaker.lastName || '').trim()}`.trim() || 'Speaker';

    const innerWrap = document.createElement('div');
    innerWrap.className = 'speaker-card-inner-wrapper';
    const contentWrap = document.createElement('div');
    contentWrap.className = 'speaker-content';
    const nameEl = document.createElement('h3');
    nameEl.className = 'speaker-card-name';
    nameEl.textContent = name;
    const bioEl = document.createElement('div');
    bioEl.className = 'speaker-card-bio about-text';
    const bioMain = document.createElement('div');
    bioMain.className = 'speaker-card-bio-main';
    bioMain.appendChild(document.createTextNode(String(speaker.shortBio || '')));
    bioEl.appendChild(bioMain);
    contentWrap.appendChild(nameEl);
    contentWrap.appendChild(bioEl);

    const longBioSection = document.createElement('section');
    longBioSection.className = 'speaker-card-long-bio';
    longBioSection.hidden = true;
    const longBioTitle = document.createElement('h4');
    longBioTitle.className = 'speaker-card-long-bio-title';
    longBioTitle.textContent = 'Bio';
    const longBioMain = document.createElement('div');
    longBioMain.className = 'speaker-card-long-bio-main about-text';
    longBioSection.appendChild(longBioTitle);
    longBioSection.appendChild(longBioMain);

    const imageWrap = document.createElement('div');
    imageWrap.className = 'speaker-image';
    const img = document.createElement('img');
    img.src = 'images/testimage.png';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    imageWrap.appendChild(img);

    innerWrap.appendChild(imageWrap);
    innerWrap.appendChild(contentWrap);
    innerWrap.appendChild(longBioSection);
    article.appendChild(innerWrap);
    if (expandableLongBio) {
        article.setAttribute('data-expandable-bio', '');
        article.setAttribute('role', 'button');
        article.setAttribute('tabindex', '0');
        article.setAttribute('aria-expanded', 'false');
        article.setAttribute('aria-label', homeSpeakerCardBioAriaLabel(name, false));
    } else {
        article.setAttribute('aria-label', name);
    }
    track.appendChild(article);
}

function homeSpeakerBioTextForDisplay(speaker, expanded) {
    if (expanded) {
        const longText = String(speaker.longBio || '').trim();
        return longText || String(speaker.shortBio || '');
    }
    return '';
}

function homeSpeakerCardBioAriaLabel(name, expanded) {
    if (expanded) {
        return `${name}. Full biography. Press to show short biography.`;
    }
    return `${name}. Short biography. Press to show full biography.`;
}

function homeSpeakerCardIndexInTrack(article, track) {
    const cards = track.querySelectorAll(':scope > article.speaker-card');
    for (let i = 0; i < cards.length; i++) {
        if (cards[i] === article) return i;
    }
    return -1;
}

function setHomeSpeakerCardBioExpanded(article, expanded) {
    const section = article.closest('#speakers-section');
    if (!section || !section.closest('.home-section')) return;
    const list = section._homeSpeakersList;
    const track = article.closest('.speakerslider-track');
    if (!Array.isArray(list) || !list.length || !track) return;
    const idx = homeSpeakerCardIndexInTrack(article, track);
    if (idx < 0 || idx >= list.length) return;
    const speaker = list[idx];
    if (!speaker || speaker.id === '__speakerinfo__') return;
    const longBioSection = article.querySelector('.speaker-card-long-bio');
    const longBioMain = article.querySelector('.speaker-card-long-bio-main');
    if (!longBioSection || !longBioMain) return;
    const html0 = section._homeFirstCardSpeakerInfoHtml;
    if (idx === 0 && html0 && String(html0).trim()) {
        return;
    }
    const text = homeSpeakerBioTextForDisplay(speaker, expanded);
    longBioMain.textContent = text;
    longBioSection.hidden = !expanded || !text;
    article.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    const nameEl = article.querySelector('.speaker-card-name');
    const name = nameEl && nameEl.textContent ? nameEl.textContent.trim() : 'Speaker';
    article.setAttribute('aria-label', homeSpeakerCardBioAriaLabel(name, expanded));
}

function syncHomeSpeakerLongBioUniformHeight(section, expanded) {
    if (!section) return;
    const track = section.querySelector('.speakerslider-track');
    if (!track) return;
    const boxes = track.querySelectorAll(':scope > article.speaker-card .speaker-card-long-bio');
    boxes.forEach(function (box) {
        box.style.removeProperty('min-height');
    });
    if (!expanded) return;
    let maxH = 0;
    boxes.forEach(function (box) {
        if (box.hidden) return;
        const h = box.offsetHeight;
        if (h > maxH) maxH = h;
    });
    if (maxH <= 0) return;
    boxes.forEach(function (box) {
        if (box.hidden) return;
        box.style.minHeight = Math.ceil(maxH) + 'px';
    });
}

function setHomeSpeakerCardsExpandedForSection(section, expanded) {
    if (!section) return;
    const track = section.querySelector('.speakerslider-track');
    if (!track) return;
    const cards = track.querySelectorAll(':scope > article.speaker-card[data-expandable-bio]');
    cards.forEach(function (card) {
        setHomeSpeakerCardBioExpanded(card, expanded);
    });
    section._homeSpeakersExpanded = !!expanded;
    syncHomeSpeakerLongBioUniformHeight(section, !!expanded);
}

function wireHomeSpeakerCardBioExpandOnce() {
    if (wireHomeSpeakerCardBioExpandOnce._wired) return;
    wireHomeSpeakerCardBioExpandOnce._wired = true;
    document.addEventListener(
        'click',
        function (ev) {
            const card = ev.target.closest('.speakerslider-track > article.speaker-card[data-expandable-bio]');
            if (!card) return;
            if (ev.target.closest('a')) return;
            const section = card.closest('#speakers-section');
            if (!section || !section.closest('.home-section')) return;
            const expanded = card.getAttribute('aria-expanded') === 'true';
            setHomeSpeakerCardsExpandedForSection(section, !expanded);
        },
        false
    );
    document.addEventListener(
        'keydown',
        function (ev) {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            const t = ev.target;
            if (!t || !t.closest) return;
            const card = t.closest('.speakerslider-track > article.speaker-card[data-expandable-bio]');
            if (!card || t !== card) return;
            if (ev.target.closest('a')) return;
            const section = card.closest('#speakers-section');
            if (!section || !section.closest('.home-section')) return;
            ev.preventDefault();
            const expanded = card.getAttribute('aria-expanded') === 'true';
            setHomeSpeakerCardsExpandedForSection(section, !expanded);
        },
        false
    );
    window.addEventListener('resize', function () {
        const section = document.getElementById('speakers-section');
        if (!section || !section.closest('.home-section')) return;
        syncHomeSpeakerLongBioUniformHeight(section, !!section._homeSpeakersExpanded);
    });
}

/**
 * Fills `.speakerslider-track`: optional first slide from `events/{id}` field `speakerinfo`, then all
 * `events/{id}/speakers` docs (each own card). Uses `TBS27_HOME_PROGRAMME_EVENT_ID` like the home programme row.
 */
async function populateHomeSpeakersSliderFromFirebase(speakersWrapperEl) {
    if (!speakersWrapperEl) return;
    wireHomeSpeakerCardBioExpandOnce();
    const track = speakersWrapperEl.querySelector('.speakerslider-track');
    if (!track) return;
    try {
        track.innerHTML = '';
        const eventId = TBS27_HOME_PROGRAMME_EVENT_ID;
        const [speakers, speakerinfoRaw] = await Promise.all([
            fetchHomeSpeakersListFromFirebase(eventId),
            fetchHomeEventSpeakerInfoFromFirebase(eventId)
        ]);
        const speakerinfoHtml = String(speakerinfoRaw || '').trim();
        if (!speakers.length && !speakerinfoHtml) {
            speakersWrapperEl._homeSpeakersList = [];
            speakersWrapperEl._homeFirstCardSpeakerInfoHtml = null;
            appendHomeSpeakerPlaceholder(track, 'Speakers to be announced.');
            return;
        }

        const hasInfoCard = !!speakerinfoHtml;
        const syntheticInfo = {
            id: '__speakerinfo__',
            firstName: '',
            lastName: '',
            shortBio: '',
            longBio: ''
        };
        speakersWrapperEl._homeFirstCardSpeakerInfoHtml = hasInfoCard ? speakerinfoHtml : null;
        speakersWrapperEl._homeSpeakersList = hasInfoCard ? [syntheticInfo].concat(speakers.slice()) : speakers.slice();
        speakersWrapperEl._homeSpeakersExpanded = false;
        if (hasInfoCard) {
            appendHomeSpeakerinfoCard(track, speakerinfoHtml);
        }
        speakers.forEach(function (s, i) {
            const expandable = String(s.longBio || '').trim().length > 0;
            appendHomeSpeakerCard(track, s, expandable);
        });
    } finally {
        delete speakersWrapperEl.dataset.speakersScrollbarWired;
        wireSpeakersSliderScrollbar();
    }
}

const PROGRAMME_INDEX_SLIDE_DEFAULTS = [
    '<div class="programme-tuesday"><div class="programme-day-content programmestyle"><p>Programme details for Tuesday will appear here.</p></div></div>',
    '<div class="programme-wednesday"><div class="programme-day-content programmestyle"><p>Programme details for Wednesday will appear here.</p></div></div>',
    '<div class="programme-thursday"><div class="programme-day-content programmestyle"><p>Programme details for Thursday will appear here.</p></div></div>',
    '<div class="programme-friday"><div class="programme-day-content programmestyle"><p>Programme details for Friday will appear here.</p></div></div>'
];

async function buildHomeProgrammeSliderDaySlidesHTML() {
    const source = document.getElementById('programme-index-source');
    const parts = [];
    const dayFetches = PROGRAMME_INDEX_DAY_ORDER.map(function (day) {
        if (HOME_PROGRAMME_FIREBASE_DATE_BY_DAY[day]) {
            return fetchHomeProgrammeDayHtmlFromFirebase(day);
        }
        return Promise.resolve('');
    });
    const dayHtmlByIndex = await Promise.all(dayFetches);
    for (let i = 0; i < PROGRAMME_INDEX_DAY_ORDER.length; i++) {
        const day = PROGRAMME_INDEX_DAY_ORDER[i];
        const fromFirebase = dayHtmlByIndex[i];
        if (fromFirebase) {
            parts.push(normalizeProgrammeSlideHtml(day, fromFirebase));
            continue;
        }
        try {
            const fromLs = localStorage.getItem(TBS_TEXTEDITOR_PROGRAMME_LS_PREFIX + day);
            if (fromLs != null && fromLs.length > 0) {
                parts.push(normalizeProgrammeSlideHtml(day, fromLs));
                continue;
            }
        } catch (e) {
            /* ignore quota / private mode */
        }
        if (source) {
            const el = source.querySelector('.programme-' + day);
            if (el) {
                parts.push(el.outerHTML);
                continue;
            }
        }
        parts.push(PROGRAMME_INDEX_SLIDE_DEFAULTS[i] || PROGRAMME_INDEX_SLIDE_DEFAULTS[0]);
    }
    // First card: `tbs/Snippets.Programmeinfo`, then localStorage draft, then hero teaser copy.
    let infoHtmlRaw = String(await fetchHomeProgrammeBandIntroFromSnippets() || '').trim();
    if (!infoHtmlRaw) {
        try {
            const fromLs = localStorage.getItem(TBS_TEXTEDITOR_HOME_PROGRAMMEINFO_LS_KEY);
            if (fromLs != null && String(fromLs).trim() !== '') {
                infoHtmlRaw = String(fromLs).trim();
            }
        } catch (e) {
            /* ignore */
        }
    }
    if (!infoHtmlRaw) {
        infoHtmlRaw = HOME_PROGRAMME_TEASER_ABOUT_INNER_HTML.trim();
    }
    const infoSlide = normalizeProgrammeInfoSlideHtml(infoHtmlRaw);
    if (infoSlide) {
        parts.unshift(infoSlide);
    }
    return parts;
}

// Display news grid with records
async function displayNewsGrid(records) {
    const feedContent = document.querySelector('.feed-section-inner-wrapper');
    if (!feedContent) {
        console.error('Feed content element not found in displayNewsGrid');
        return;
    }
    
    const validRecords = filterValidNewsFeedRecords(records);
    
    // Create news grid container
    const newsGrid = document.createElement('div');
    newsGrid.className = 'news-grid';
    
    const initialSlice = validRecords.slice(0, HOME_FEED_INITIAL_COUNT);
    await appendNewsCardsToGrid(newsGrid, initialSlice);
    if (!validRecords.length) {
        newsGrid.innerHTML =
            '<p class="empty-feed-message">No published items to show yet.</p>';
    }

    // Clear existing content, add title and grid
    feedContent.innerHTML = '';
    const programmeSliderSection = document.createElement('div');
    programmeSliderSection.className = 'home-programme-section';
    const programmeDaySlides = await buildHomeProgrammeSliderDaySlidesHTML();
    const programmeSliderTrackInner = programmeDaySlides.join('');
    const programmeDotsHTML = programmeDaySlides
        .map(
            (_, i) =>
                '<button type="button" class="introslider-dot" data-index="' +
                i +
                '" aria-label="Programme slide ' +
                (i + 1) +
                '"></button>'
        )
        .join('');
    programmeSliderSection.innerHTML =
        '<div class="programme-section home-stage-hidden" id="home-programme-title" role="region" aria-label="Programme">' +
        '<div class="programmeslider-innerwrapper">' +
        '<div class="programme-slider">' +
        programmeSliderTrackInner +
        '</div>' +
        '<div class="home-introslider-scrollbar" aria-hidden="true">' +
        '<div class="home-introslider-scrollbar-track">' +
        '<div class="home-introslider-scrollbar-thumb"></div>' +
        '</div>' +
        '</div>' +
        '<div class="introslider-indicators" aria-label="Programme slider position">' +
        programmeDotsHTML +
        '</div>' +
        '</div>' +
        '</div>';
    // On the home view, render the programme slider as a direct child of .home-section (before the speakers row).
    const homeSection = document.querySelector('body.home-view .home-section');
    if (homeSection) {
        const existing = homeSection.querySelector(':scope > .programme-section');
        if (existing) existing.remove();
        homeSection
            .querySelectorAll(':scope > .home-speakers-programme-spacer, :scope > .home-programme-after-spacer')
            .forEach((el) => el.remove());

        const programmeSection = programmeSliderSection.querySelector('.programme-section');

        const heroIntrosliderWrapper = homeSection.querySelector(':scope > .introslider-wrapper');
        const homeFeedBlock = homeSection.querySelector(':scope > .feed-section');
        const speakersSliderWrapper = homeSection.querySelector(':scope > .speaker-section');
        if (programmeSection && speakersSliderWrapper) {
            speakersSliderWrapper.insertAdjacentElement('beforebegin', programmeSection);
        } else if (programmeSection && homeFeedBlock) {
            homeSection.insertBefore(programmeSection, homeFeedBlock);
        } else if (heroIntrosliderWrapper && programmeSection) {
            homeSection.insertBefore(programmeSection, heroIntrosliderWrapper.nextSibling);
        } else if (programmeSection) {
            homeSection.appendChild(programmeSection);
        }

        const registrationOuter = homeSection.querySelector(':scope > .registration-section');
        const ondemandSectionEl = homeSection.querySelector(':scope > .ondemand-section');
        if (registrationOuter) {
            if (ondemandSectionEl) {
                ondemandSectionEl.insertAdjacentElement('afterend', registrationOuter);
            } else if (programmeSection) {
                programmeSection.insertAdjacentElement('afterend', registrationOuter);
            }
        }
    } else {
        feedContent.appendChild(programmeSliderSection);
    }
    const feedTitle = document.createElement('h2');
    feedTitle.className = 'section-titles';
    feedTitle.id = 'home-feed-latest-heading';
    feedTitle.textContent = 'Latest';
    feedContent.appendChild(feedTitle);
    feedContent.appendChild(newsGrid);
    attachHomeFeedLoadMore(feedContent, newsGrid, validRecords);

    wireSliderIndicators();
}


// YouTube API event listener setup for individual cards
function setupYouTubeCardListener(iframe, newsCard, originalEmbedUrl) {
    // Wait for YouTube API to be ready
    if (typeof YT !== 'undefined' && YT.Player) {
        new YT.Player(iframe, {
            events: {
                'onStateChange': function(event) {
                    // When video ends (state = 0), revert card to first frame
                    if (event.data === YT.PlayerState.ENDED) {
                        revertYouTubeCardToFirstFrame(newsCard, originalEmbedUrl);
                    }
                }
            }
        });
    } else {
        // Fallback: try again after a short delay
        setTimeout(() => setupYouTubeCardListener(iframe, newsCard, originalEmbedUrl), 1000);
    }
}

// Revert YouTube card to show YouTube thumbnail
function revertYouTubeCardToFirstFrame(newsCard, originalEmbedUrl) {
    const container = newsCard.querySelector('.news-card-youtube-container');
    if (!container) return;
    
    // Extract video ID from original URL
    let videoId = '';
    if (originalEmbedUrl.includes('youtube.com/embed/')) {
        videoId = originalEmbedUrl.split('embed/')[1].split('?')[0];
    } else if (originalEmbedUrl.includes('youtube.com/watch?v=')) {
        videoId = originalEmbedUrl.split('v=')[1].split('&')[0];
    } else if (originalEmbedUrl.includes('youtu.be/')) {
        videoId = originalEmbedUrl.split('youtu.be/')[1].split('?')[0];
    } else if (originalEmbedUrl.includes('youtube.com/shorts/')) {
        videoId = originalEmbedUrl.split('shorts/')[1].split('?')[0];
    }
    
        if (videoId) {
        // Create YouTube thumbnail URL (standard thumbnail, not first frame)
        const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        
        // Replace iframe with YouTube thumbnail image
        const embedDiv = container.querySelector('.news-card-youtube-embed');
        if (embedDiv) {
            embedDiv.innerHTML = `
                <img src="${thumbnailUrl}" 
                     alt="YouTube video thumbnail" 
                     style="width: 100%; height: 100%; object-fit: cover; border-radius: 10px;">
            `;
        }
        
        // Add click handler to reload video when clicked
        container.style.cursor = 'pointer';
        container.addEventListener('click', function() {
            // Reload the original iframe
            embedDiv.innerHTML = `
                <iframe 
                    src="${originalEmbedUrl}" 
                    width="100%" 
                    height="100%" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
            `;
            
            // Set up listener again for the new iframe
            const newIframe = embedDiv.querySelector('iframe');
            if (newIframe) {
                newIframe.addEventListener('load', function() {
                    setupYouTubeCardListener(newIframe, newsCard, originalEmbedUrl);
                });
            }
            
            // Remove click handler
            container.style.cursor = 'default';
            container.removeEventListener('click', arguments.callee);
        });
    }
}

// Show video from URL (for news feed video cards)
function showVideoFromUrl(videoUrl) {
    // First try to find in allPosts (blog posts)
    let videoPost = allPosts.find(post => {
        // Safety check for post structure
        if (!post) {
            return false;
        }
        
        // Check all possible URL fields (blog posts use transformed structure)
        const postUrls = [
            post.youtubeUrl,
            post.url,
            post.youtube
        ].filter(url => url); // Remove null/undefined URLs
        
        // Try exact match first
        let urlMatch = postUrls.some(url => url === videoUrl);
        
        // If no exact match, try YouTube ID extraction
        if (!urlMatch) {
            const extractYouTubeId = (url) => {
                if (!url) return null;
                const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/);
                return match ? match[1] : null;
            };
            
            const targetId = extractYouTubeId(videoUrl);
            if (targetId) {
                urlMatch = postUrls.some(url => {
                    const postId = extractYouTubeId(url);
                    return postId === targetId;
                });
            }
        }
        
        return urlMatch;
    });
    
    if (videoPost) {
        // Show the video like in the blog, but indicate it's from the feed
        showPostOnSamePage(videoPost, true); // true indicates it's from the feed
    } else {
        // If not found in blog posts, try to find in news feed data
        if (window.allNewsRecords && window.allNewsRecords.length > 0) {
            const newsVideoRecord = window.allNewsRecords.find(record => {
                if (!record || !record.fields) return false;
                
                const recordUrl = record.fields.URL;
                if (!recordUrl) return false;
                
                // Try exact match first
                if (recordUrl === videoUrl) return true;
                
                // Try YouTube ID extraction
                const extractYouTubeId = (url) => {
                    if (!url) return null;
                    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([^&\n?#]+)/);
                    return match ? match[1] : null;
                };
                
                const targetId = extractYouTubeId(videoUrl);
                const recordId = extractYouTubeId(recordUrl);
                
                return targetId && recordId && targetId === recordId;
            });
            
            if (newsVideoRecord) {
                // Convert news record to blog post format
                const convertedPost = {
                    id: newsVideoRecord.id,
                    title: newsVideoRecord.fields.Title || 'Video',
                    name: newsVideoRecord.fields.Name || null, // Add Name field
                    excerpt: newsVideoRecord.fields.Text || 'Video content',
                    content: newsVideoRecord.fields.Text || 'Video content',
                    category: newsVideoRecord.fields.Type || 'video',
                    topic: newsVideoRecord.fields.Type || 'video',
                    date: newsVideoRecord.fields.Date || newsVideoRecord.createdTime || new Date().toISOString().split('T')[0],
                    readTime: '5 min',
                    likes: 0,
                    comments: 0,
                    image: null,
                    youtubeUrl: newsVideoRecord.fields.URL,
                    url: newsVideoRecord.fields.URL,
                    youtube: newsVideoRecord.fields.URL,
                    slug: newsVideoRecord.id,
                    featured: false
                };
                
                showPostOnSamePage(convertedPost, true); // true indicates it's from the feed
                return;
            }
        }
    }
}

// Monitor featured content title for line breaks and hide shorts if title breaks
function monitorFeaturedTitleBreak() {
    const featuredTitle = document.querySelector('.featured-text-content h3');
    const shortsContainer = document.querySelector('.featured-social');
    
    if (!featuredTitle || !shortsContainer) return;
    
    // Always show the shorts container - don't hide it based on title breaks
    shortsContainer.style.display = 'block';
    
    function checkTitleBreak() {
        // Get the computed line height
        const lineHeight = parseInt(window.getComputedStyle(featuredTitle).lineHeight);
        const titleHeight = featuredTitle.offsetHeight;
        
        // Always keep shorts visible - don't hide based on title breaks
        shortsContainer.style.display = 'block';
    }
    
    // Check on load and resize
    checkTitleBreak();
    window.addEventListener('resize', checkTitleBreak);
}

// Format date as Today / Yesterday / nd
function formatRelativeDay(dateInput) {
    const d = new Date(dateInput);
    const today = new Date();
    // Normalize to midnight
    const toMidnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const md = toMidnight(d);
    const mt = toMidnight(today);
    const msPerDay = 24 * 60 * 60 * 1000;
    const diffDays = Math.round((mt - md) / msPerDay);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays > 1) return `${diffDays} days ago`;
    // Future dates fallback
    return 'Today';
}

// Render shout items into shoutbox
function renderShoutbox(shoutRecords) {
    const box = document.querySelector('.shoutbox');
    if (!box) return;
    if (!Array.isArray(shoutRecords) || shoutRecords.length === 0) {
        box.innerHTML = '';
        return;
    }
    // Sort newest first
    const sorted = shoutRecords.slice().sort((a, b) => new Date(b.fields.Date || b.createdTime) - new Date(a.fields.Date || a.createdTime));
    // Put Featured shouts on top
    const featuredFirst = [
        ...sorted.filter(r => isRecordFeatured(r)),
        ...sorted.filter(r => !isRecordFeatured(r))
    ];
    const rows = featuredFirst.map(rec => {
        const dateVal = rec.fields.Date || rec.createdTime;
        const d = dateVal ? new Date(dateVal) : new Date(rec.createdTime);
        const dateStr = formatRelativeDay(d);
        const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const name = rec.fields.Name || '';
        const title = rec.fields.Title || 'Untitled';
        const dateWithOptionalTime = (dateStr === 'Today' || dateStr === 'Yesterday') ? `${dateStr} ${timeStr}` : dateStr;
        const rowClass = isRecordFeatured(rec) ? 'shout-row shout-featured' : 'shout-row';
        return `
            <div class="${rowClass}">
                <div class="shout-top-row">
                    <p class="shout-name">${name}</p>
                    <p class="shout-date">${dateWithOptionalTime}</p>
                </div>
                <p class="shout-title">${title}</p>
            </div>
        `;
    }).join('');
    box.innerHTML = `
        <div class="shoutbox-header">
            <span class="material-symbols-outlined">record_voice_over</span>
        </div>
        <div class="shout-list">${rows}</div>`;
}

/** Only exact literal "featured" (case-insensitive) counts as featured. */
function hasFeaturedFieldValue(r) {
    if (!r || !r.fields) return false;
    const v = r.fields.Featured ?? r.fields.featured;
    if (v == null) return false;
    return String(v).trim().toLowerCase() === 'featured';
}

// Helper: check if record is featured (field can be "Featured" or "featured")
function isRecordFeatured(r) {
    return hasFeaturedFieldValue(r);
}

/** Home Latest grid: Firestore `Published` must be yes (string "Yes" case-insensitive, boolean true, or 1). */
function isHomeFeedPublishedYes(fields) {
    if (!fields || typeof fields !== 'object') return false;
    const v = fields.Published != null ? fields.Published : fields.published;
    if (v === true || v === 1) return true;
    if (typeof v === 'string' && String(v).trim().toLowerCase() === 'yes') return true;
    return false;
}

/** Records eligible for a feed card (same rules as Latest grid). */
function filterValidNewsFeedRecords(records) {
    return (records || []).filter((record) => {
        const f = record && record.fields ? record.fields : {};
        if (!isHomeFeedPublishedYes(f)) return false;
        const title = f.Title || f.Name || '';
        const excerpt = f.Excerpt || f.Content || '';
        const type = (f.Type || '').toString().toLowerCase().trim();
        const hasVideoUrl = !!(f.URL || f['Video URL'] || f['YouTube URL'] || f.Link || f.Youtube);
        const hasImage = !!f.Image;
        const hasText = !!(title || excerpt);
        if (type === 'video' || type === 'edit') {
            return hasText || hasImage || hasVideoUrl;
        }
        return hasText || hasImage;
    });
}

/**
 * Valid rows with Featured set first (newest-first among them), then all other rows in date order.
 * @param {Array} records Content rows, newest-first (e.g. `allRecords` from loadNewsFeed).
 * @returns {Array}
 */
function orderHomeFeedWithFeaturedFirst(records) {
    if (!records || records.length === 0) return records || [];
    const validIds = new Set(filterValidNewsFeedRecords(records).map((r) => r.id));
    const featured = [];
    const rest = [];
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (validIds.has(r.id) && hasFeaturedFieldValue(r)) featured.push(r);
        else rest.push(r);
    }
    return featured.concat(rest);
}

// Populate morevideos container with latest 20 videos (latest first)
async function populateMoreVideosCards(currentPostId) {
    const morevideosCards = document.getElementById('morevideosCards');
    if (!morevideosCards) {
        console.error('morevideosCards element not found');
        return;
    }
    
    try {
        // Show latest 20 videos from ALL events (no category/event filter), exclude current post only
        const latestVideos = (allPosts || [])
            .filter(post => post && post.youtubeUrl && post.id != currentPostId)
            .slice(0, 20);
        
        if (latestVideos.length === 0) {
            morevideosCards.innerHTML = '<p>No other videos available.</p>';
            return;
        }
        
        // Create cards only when an explicit Image URL exists on the post.
        let cardsHTML = '';
        latestVideos.forEach((post) => {
            const hasImageUrl = post.image && typeof post.image === 'string' && post.image.startsWith('http');
            const imageUrl = hasImageUrl ? post.image : '';
            if (imageUrl && post.youtubeUrl) {
                const safeImgSrc = imageUrl.replace(/"/g, '&quot;');
                const safeYoutubeUrl = (post.youtubeUrl || '').replace(/'/g, "\\'");
                const safeTitle = (post.title || '').replace(/"/g, '&quot;');
                cardsHTML += `
                    <div class="morevideos-card" onclick="showVideoFromUrl('${safeYoutubeUrl}')">
                        <div class="morevideos-card-image">
                            <img src="${safeImgSrc}" alt="${safeTitle}" />
                        </div>
                    </div>
                `;
            }
        });
        
        morevideosCards.innerHTML = cardsHTML;
        
    } catch (error) {
        console.error('Error populating morevideos cards:', error);
        morevideosCards.innerHTML = '<p>Error loading related videos.</p>';
    }
}

// No-op: video-layout height is now driven only by .viewing via CSS (featured column is absolutely positioned in some layouts)
function matchMoreVideosHeight() {}

/**
 * Feed card excerpt: normalize text into HTML that shows line breaks.
 * - Plain newlines → `<br>`
 * - Common typo `<br<br>` (missing `>`) → `<br><br>`
 * - Escaped `&lt;br&gt;` from APIs → `<br>`
 */
function formatNewsFeedExcerptHtml(raw) {
    if (raw == null || raw === '') return '';
    let s = String(raw);
    // Malformed double-break typos from pasted rich text
    s = s.replace(/<br<br\s*>/gi, '<br><br>');
    s = s.replace(/<br\s*<\s*br\s*>/gi, '<br><br>');
    s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    s = s.replace(/&lt;br&gt;/gi, '<br>');
    s = s.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
    return s;
}

// Create individual news container
async function createNewsCard(record) {
    const newsCard = document.createElement('div');
    newsCard.className = 'news-card';
    newsCard.style.cursor = 'pointer';
    
    // Get title, text, date, and type
    let title =
        record.fields.Title ||
        record.fields.Name ||
        pickFirstReadableStringField(record.fields, ['title', 'name', 'headline', 'subject']) ||
        '';
    let text =
        record.fields.Excerpt ||
        record.fields.Content ||
        pickFirstReadableStringField(record.fields, ['excerpt', 'content', 'body', 'description', 'text']) ||
        '';
    const date = record.fields.Date || record.createdTime || new Date().toISOString().split('T')[0];
    const type = record.fields.Type || '';
    // Unified video URL across possible fields
    const unifiedVideoUrl = record.fields.URL || record.fields['Video URL'] || record.fields.Link || record.fields['YouTube URL'] || record.fields['Video Link'] || record.fields.Youtube;
    const isFeatured = hasFeaturedFieldValue(record);

    // Apply background color from Fieldcolour field if it exists (featured cards use CSS pink instead)
    const fieldColour = record.fields.Fieldcolour;
    if (fieldColour && !isFeatured) {
        // Map color names to CSS color values
        const colorMap = {
            'Pink': '#fce7f3',
            'Yellow': '#fef3c7', 
            'Blue': '#F0FFFF'
        };
        const cssColor = colorMap[fieldColour] || fieldColour;
        newsCard.style.backgroundColor = cssColor;
    }
    
    // Get image URL from stored image field
    let imageUrl = '';
    if (record.fields.Image) {
        if (typeof record.fields.Image === 'string') {
            imageUrl = record.fields.Image;
        } else if (Array.isArray(record.fields.Image) && record.fields.Image.length > 0) {
            imageUrl = record.fields.Image[0].url;
        } else if (record.fields.Image && record.fields.Image.url) {
            imageUrl = record.fields.Image.url;
        }
    }
    
    // For Video/Edit, optionally reuse cached text metadata only (no image fallback).
    let videoData = null;
    if (isVideoOrEditType(type) && record.fields.URL && window.videoDataMap) {
        videoData = window.videoDataMap[record.id];
        if (videoData) {
            // Use video data for title and text
            if (videoData.title) {
                title = videoData.title;
            }
            if (videoData.excerpt) {
                text = videoData.excerpt;
            }
        }
        
    }

    // Guard: hide truly empty records (no title/excerpt, no image, and for Video no URL)
    const hasText = !!(title || text);
    const hasImageFinal = !!imageUrl;
    const hasVideoUrl = !!(record.fields.URL || record.fields['Video URL'] || record.fields['YouTube URL'] || record.fields.Link || record.fields.Youtube);
    if (!hasText && !hasImageFinal && (!isVideoOrEditType(type) || !hasVideoUrl)) {
        return null;
    }
    
    // Format date
    const formattedDate = formatDate(date);
    
    // Check if post is less than 24 hours old
    const postDate = new Date(date);
    const now = new Date();
    const hoursDiff = (now - postDate) / (1000 * 60 * 60); // Convert to hours
    const isNew = hoursDiff < 24;
    const newBadgeHtml = isNew ? '<span class="news-card-new-badge">New</span>' : '';
    const featuredBadgeHtml = isFeatured ? '<span class="news-card-new-badge">FEATURED</span>' : '';

    // Use full text without truncation (normalize newlines so they render as breaks in the card)
    const truncatedText = formatNewsFeedExcerptHtml(text);
    
    // Create button based on type (for visual purposes - entire card is clickable)
    let showMoreButton = '';
    const trimmedType = type ? type.trim().toLowerCase() : '';
    const typeDisplayTrimmed = type ? String(type).trim() : '';
    const typeBadgeHtml =
        !typeDisplayTrimmed
            ? ''
            : typeDisplayTrimmed.toLowerCase() === 'edit'
                ? '<span class="news-card-new-badge">EDIT</span>'
                : `<span class="news-card-category">${typeDisplayTrimmed}</span>`;

    // Check for URL in various possible field names
    const videoUrl = unifiedVideoUrl;
    
    // Remove view links from feed cards
    showMoreButton = '';
    
    // Check if this is a YouTube activity
    if (trimmedType && trimmedType.toLowerCase() === 'short' && videoUrl) {
        // Convert YouTube URL to embed URL
        let embedUrl = '';
        const youtubeUrl = videoUrl;
        
        // Handle different YouTube URL formats
        if (youtubeUrl.includes('youtube.com/watch?v=')) {
            const videoId = youtubeUrl.split('v=')[1].split('&')[0];
            embedUrl = `https://www.youtube.com/embed/${videoId}`;
        } else if (youtubeUrl.includes('youtu.be/')) {
            const videoId = youtubeUrl.split('youtu.be/')[1].split('?')[0];
            embedUrl = `https://www.youtube.com/embed/${videoId}`;
        } else if (youtubeUrl.includes('youtube.com/shorts/')) {
            const videoId = youtubeUrl.split('shorts/')[1].split('?')[0];
            embedUrl = `https://www.youtube.com/embed/${videoId}`;
        } else if (youtubeUrl.includes('youtube.com/embed/')) {
            embedUrl = youtubeUrl; // Already an embed URL
        }
        
        if (embedUrl) {
            // Add API parameters to detect video end
            const embedUrlWithAPI = embedUrl + (embedUrl.includes('?') ? '&' : '?') + 'enablejsapi=1&origin=' + encodeURIComponent(window.location.origin);
            const uniqueId = `youtube-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            newsCard.innerHTML = `
                <div class="news-card-youtube-container" data-video-id="${uniqueId}">
                    <div class="news-card-youtube-embed">
                        <iframe 
                            id="${uniqueId}"
                            src="${embedUrlWithAPI}" 
                            width="100%" 
                            height="100%" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                </div>
                <div class="news-card-content">
                    <div class="news-card-title-row">
                        <h3 class="news-card-title">${title}</h3>
                        <div class="news-card-badges">
                            ${newBadgeHtml}
                            ${featuredBadgeHtml}
                            ${typeBadgeHtml}
                        </div>
                    </div>
                    <div class="news-card-meta">
                        <p class="news-card-date">${formattedDate}</p>
                    </div>
                    <div class="news-card-text-row">
                        <div class="news-card-text">${truncatedText}</div>
                        <div class="news-card-controls news-card-controls--collapsed" aria-hidden="true"></div>
                    </div>
                </div>
            `;
            
            // Set up YouTube API event listener when iframe loads
            const iframe = newsCard.querySelector('iframe');
            if (iframe) {
                iframe.addEventListener('load', function() {
                    setupYouTubeCardListener(iframe, newsCard, embedUrl);
                });
            }
        } else {
            // Fallback to regular card if URL is invalid - no image container
            newsCard.innerHTML = `
                <div class="news-card-content">
                    <div class="news-card-title-row">
                        <h3 class="news-card-title">${title}</h3>
                        <div class="news-card-badges">
                            ${newBadgeHtml}
                            ${featuredBadgeHtml}
                            ${typeBadgeHtml}
                        </div>
                    </div>
                    <div class="news-card-meta">
                        <p class="news-card-date">${formattedDate}</p>
                    </div>
                    <div class="news-card-text-row">
                        <div class="news-card-text">${truncatedText}</div>
                        <div class="news-card-controls news-card-controls--collapsed" aria-hidden="true"></div>
                    </div>
                    <p class="youtube-error">Invalid YouTube URL: ${youtubeUrl}</p>
                    </div>
            `;
        }
    } else {
        // Regular news card layout
        const imageContainer = imageUrl ? `
            <div class="news-card-image">
                <img src="${imageUrl}" alt="${title}" class="news-card-thumbnail">
                </div>
        ` : '';
        
        newsCard.innerHTML = `
            ${imageContainer}
            <div class="news-card-content">
                <div class="news-card-title-row">
                    <h3 class="news-card-title">${title}</h3>
                    ${isNew || isFeatured || typeBadgeHtml ? `
                    <div class="news-card-badges">
                        ${newBadgeHtml}
                        ${featuredBadgeHtml}
                        ${typeBadgeHtml}
                    </div>` : ''}
                </div>
                <div class="news-card-meta">
                    <p class="news-card-date">${formattedDate}</p>
                </div>
                <div class="news-card-text-row">
                    <div class="news-card-text">${truncatedText}</div>
                    <div class="news-card-controls news-card-controls--collapsed" aria-hidden="true"></div>
                </div>
                ${showMoreButton}
        </div>
    `;
    }

    if (isFeatured) {
        newsCard.classList.add('news-card--featured');
    }

    // Add click event listener to the entire card
    newsCard.addEventListener('click', function(e) {
        const t = e.target;
        const fromEl = t instanceof Element ? t : t.parentElement;
        if (fromEl && fromEl.closest('.news-card-controls')) {
            return;
        }
        e.preventDefault();
        
        // Check if this is a video card (use same URL detection logic as button)
        const trimmedType = type ? type.trim().toLowerCase() : '';
        const videoUrl = record.fields.URL || record.fields['Video URL'] || record.fields.Link || record.fields['YouTube URL'] || record.fields['Video Link'] || record.fields.Youtube;
        
        if ((trimmedType === 'video' || trimmedType === 'edit') && videoUrl) {
            showVideoFromUrl(videoUrl);
        } else {
            // For non-video cards, show alert for now
            alert('More content coming soon!');
        }
    });
    
    return newsCard;
}

// Normalize Event/Events field (string or array) to a single string
function normalizeEventField(val) {
    if (val == null || val === '') return 'uncategorized';
    if (Array.isArray(val)) return (val[0] && String(val[0]).trim()) ? String(val[0]).trim() : 'uncategorized';
    return String(val).trim() || 'uncategorized';
}

// Get unique categories (events) from all posts
function getUniqueCategories() {
    const categories = new Set();
    (allPosts || []).forEach(post => {
        const raw = post.category;
        const cat = (raw != null && String(raw).trim()) ? String(raw).trim() : 'Uncategorized';
        categories.add(cat);
    });
    return Array.from(categories).sort();
}

// Get a sample topic based on post content
function getSampleTopic() {
    const topics = ['Technology', 'Healthcare', 'Innovation', 'Research', 'Education', 'Leadership'];
    return topics[Math.floor(Math.random() * topics.length)];
}

// Populate category and topic filters after posts are loaded
function populateFilters() {
    const categories = getUniqueCategories();
    const topics = getUniqueTopics();
    
    
    // Populate category/event filters (Past talks uses id="eventFilters", other views may use "categoryFilters")
    const categoryFilters = document.getElementById('eventFilters') || document.getElementById('categoryFilters');
    if (categoryFilters) {
        const categoryButtons = categories.map(category => 
            `<button class="filter-btn" data-category="${category}">${category}</button>`
        ).join('');
        categoryFilters.innerHTML = `<button class="filter-btn active" data-category="all">All events</button>${categoryButtons}`;
    }
    
    // Populate topic filters
    const topicFilters = document.getElementById('topicFilters');
    if (topicFilters) {
        const topicButtons = topics.map(topic => 
            `<button class="filter-btn topic-btn" data-topic="${topic}">${topic}</button>`
        ).join('');
        topicFilters.innerHTML = `<button class="filter-btn topic-btn active" data-topic="all">All</button>${topicButtons}`;
    }
    
    // Update global variables for the new filter buttons
    filterBtns = document.querySelectorAll('.filter-btn:not(.topic-btn)');
    
    // Setup event listeners for the new filter buttons
    setupEventListeners();
    setupTopicButtonListeners();
}

// Get unique topics from all posts
function getUniqueTopics() {
    const topics = new Set();
    allPosts.forEach(post => {
        if (post.topic) {
            // Handle both single topic (string) and multiple topics (array)
            if (Array.isArray(post.topic)) {
                // Multiple topics - add each one
                post.topic.forEach(topic => {
                    if (topic && topic !== 'general') {
                        topics.add(topic);
                    }
                });
            } else if (post.topic !== 'general') {
                // Single topic
                topics.add(post.topic);
            }
        }
    });
    return Array.from(topics).sort();
}

// Setup navigation event listeners
async function setupNavigationListeners() {
    bindViewLinks('feed', function(e) {
        void goToHomeFeed(e);
    });

    bindViewLinks('past-talks', async function(e) {
        e.preventDefault();
        await showBlogFeed();
    });

    bindViewLinks('flyer', async function(e) {
        await goToHomeProgramme(e);
    });

    bindViewLinks('speakers', async function(e) {
        await goToHomeSpeakers(e);
    });

    bindViewLinks('register', async function(e) {
        await goToHomeRegistration(e);
    });

    const logoLink = document.querySelector('.nav-logo');
    if (logoLink) {
        const goHomeFromLogo = function(e) {
            void goToHomeFeed(e);
        };
        logoLink.addEventListener('click', goHomeFromLogo);
        logoLink.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                goHomeFromLogo(e);
            }
        });
    }
}



// Mobile menu functionality
function setupMobileMenu() {
    if (hamburger && navMenu) {
        hamburger.addEventListener('click', function() {
            navMenu.classList.toggle('active');
        });
        // Close mobile menu when any nav link is clicked (delegation: works after links are replaced by setupNavigationListeners)
        document.addEventListener('click', function(e) {
            const link = e.target.closest('.nav-link');
            if (link && navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
            }
        });
    }
}

// Newsletter functionality
function setupNewsletter() {
    newsletterForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const email = this.querySelector('input[type="email"]').value;
        
        if (email) {
            // Simulate newsletter subscription
            showNotification('Thank you for subscribing!', 'success');
            this.reset();
        }
    });
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Style the notification
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'success' ? '#10b981' : '#3b82f6'};
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    // Remove notification after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 300);
    }, 3000);
}

// Add CSS animations for notifications
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
    
    .no-posts {
        text-align: center;
        color: #64748b;
        font-size: 1.1rem;
        grid-column: 1 / -1;
        padding: 2rem;
    }
    
    .loading {
        text-align: center;
        color: #003153;
        font-size: 1.2rem;
        grid-column: 1 / -1;
        padding: 3rem;
        font-weight: 500;
    }
    
    .error {
        text-align: center;
        color: #dc2626;
        font-size: 1.1rem;
        grid-column: 1 / -1;
        padding: 2rem;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 8px;
        margin: 1rem;
    }
`;
document.head.appendChild(style);

// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Scroll effect is handled by setupHeaderScrollEffect() function

// CTA button functionality (removed since button was deleted)

// Responsive text truncation for featured content
function setupResponsiveTextTruncation() {
    function truncateText() {
        const featuredContent = document.querySelector('.featured-text-content');
        if (!featuredContent) return;
        
        const container = document.querySelector('.helloworld');
        if (!container) return;
        
        const containerWidth = container.offsetWidth;
        const title = featuredContent.querySelector('h3');
        const paragraphs = featuredContent.querySelectorAll('p');
        const button = featuredContent.querySelector('.cta-button');
        
        if (!title || !paragraphs.length || !button) return;
        
        // Reset all text to original
        title.style.display = 'block';
        title.style.webkitLineClamp = 'none';
        title.style.overflow = 'visible';
        paragraphs.forEach(p => {
            p.style.display = 'block';
            p.style.webkitLineClamp = 'none';
            p.style.overflow = 'visible';
        });
        
        // Apply truncation based on container width
        if (containerWidth <= 320) {
            // Ultra narrow: hide first paragraph, truncate title and last paragraph
            if (paragraphs[0]) paragraphs[0].style.display = 'none';
            title.style.webkitLineClamp = '1';
            title.style.overflow = 'hidden';
            title.style.display = '-webkit-box';
            title.style.webkitBoxOrient = 'vertical';
            if (paragraphs[paragraphs.length - 1]) {
                paragraphs[paragraphs.length - 1].style.webkitLineClamp = '1';
                paragraphs[paragraphs.length - 1].style.overflow = 'hidden';
                paragraphs[paragraphs.length - 1].style.display = '-webkit-box';
                paragraphs[paragraphs.length - 1].style.webkitBoxOrient = 'vertical';
            }
        } else if (containerWidth <= 360) {
            // Very narrow: hide first paragraph, truncate title and last paragraph
            if (paragraphs[0]) paragraphs[0].style.display = 'none';
            title.style.webkitLineClamp = '1';
            title.style.overflow = 'hidden';
            title.style.display = '-webkit-box';
            title.style.webkitBoxOrient = 'vertical';
            if (paragraphs[paragraphs.length - 1]) {
                paragraphs[paragraphs.length - 1].style.webkitLineClamp = '1';
                paragraphs[paragraphs.length - 1].style.overflow = 'hidden';
                paragraphs[paragraphs.length - 1].style.display = '-webkit-box';
                paragraphs[paragraphs.length - 1].style.webkitBoxOrient = 'vertical';
            }
        } else if (containerWidth <= 480) {
            // Narrow: truncate last paragraph to 1 line
            if (paragraphs[paragraphs.length - 1]) {
                paragraphs[paragraphs.length - 1].style.webkitLineClamp = '1';
                paragraphs[paragraphs.length - 1].style.overflow = 'hidden';
                paragraphs[paragraphs.length - 1].style.display = '-webkit-box';
                paragraphs[paragraphs.length - 1].style.webkitBoxOrient = 'vertical';
            }
        } else if (containerWidth <= 768) {
            // Medium: truncate last paragraph to 2 lines
            if (paragraphs[paragraphs.length - 1]) {
                paragraphs[paragraphs.length - 1].style.webkitLineClamp = '2';
                paragraphs[paragraphs.length - 1].style.overflow = 'hidden';
                paragraphs[paragraphs.length - 1].style.display = '-webkit-box';
                paragraphs[paragraphs.length - 1].style.webkitBoxOrient = 'vertical';
            }
        }
    }
    
    // Run on load and resize
    truncateText();
    window.addEventListener('resize', truncateText);
}

// Store the scroll handler so we can remove it if needed
let navbarScrollHandler = null;

let homeNavbarScrollHandler = null;

let homeNavbarResizeHandler = null;

let pastTalksStripResizeHandler = null;

/** Prussian strip height = full fixed .navbar (vertical padding + .nav-container + glass borders). */
function syncPastTalksPrussianStripToNavbar() {
    if (!document.body.classList.contains('past-talks-open')) return;
    const nav = document.querySelector('.navbar');
    const picture = document.querySelector('.home-section > picture');
    if (!nav || !picture) return;
    const h = nav.getBoundingClientRect().height;
    if (!(h > 0)) return;
    const px = `${Math.round(h * 100) / 100}px`;
    picture.style.setProperty('height', px, 'important');
    picture.style.setProperty('min-height', px, 'important');
}

function clearPastTalksPrussianStripInlineSize() {
    const picture = document.querySelector('.home-section > picture');
    if (!picture) return;
    picture.style.removeProperty('height');
    picture.style.removeProperty('min-height');
}

function teardownPastTalksPrussianStripSync() {
    if (pastTalksStripResizeHandler) {
        window.removeEventListener('resize', pastTalksStripResizeHandler);
        pastTalksStripResizeHandler = null;
    }
    clearPastTalksPrussianStripInlineSize();
}

function setupPastTalksPrussianStripSync() {
    teardownPastTalksPrussianStripSync();
    if (!document.body.classList.contains('past-talks-open')) return;
    if (!document.querySelector('.home-section > picture')) return;
    pastTalksStripResizeHandler = function () {
        syncPastTalksPrussianStripToNavbar();
    };
    window.addEventListener('resize', pastTalksStripResizeHandler, { passive: true });
    const run = () => syncPastTalksPrussianStripToNavbar();
    requestAnimationFrame(() => requestAnimationFrame(run));
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(run);
    }
}

let homeHeroIntrosliderPosterGapResizeHandler = null;

function syncHomeHeroIntrosliderPosterGap(desiredGapPx = 8) {
    if (!document.body.classList.contains('home-view')) return;
    const homeSection = document.querySelector('body.home-view .home-section');
    if (!homeSection) return;

    // Use the same requested gap for mobile + desktop.
    const effectiveGapPx = desiredGapPx;

    // Direct child poster and hero introslider only (not the programme slider in the feed).
    const posterImg = homeSection.querySelector(':scope > picture img.home-poster-wide, :scope > picture img');
    const sliderWrapper = homeSection.querySelector(':scope > .introslider-wrapper');

    if (!posterImg || !sliderWrapper) return;

    // Slider wrapper sits in normal flow right after the poster; we shift it up via
    // the overlap CSS variable so that:
    //   posterBottom - sliderBottom = desiredGapPx
    const sliderHeight = sliderWrapper.getBoundingClientRect().height;
    const targetOverlapPx = sliderHeight + effectiveGapPx;
    homeSection.style.setProperty('--home-hero-introslider-poster-overlap', `${targetOverlapPx}px`);
    /* Same value as poster-bottom ↔ slider-bottom gap: pushes .home-social-row-container below the poster (it would otherwise sit on the image). */
    homeSection.style.setProperty('--home-hero-poster-slider-gap', `${effectiveGapPx}px`);

    // Second pass to correct for rounding / font settling.
    requestAnimationFrame(() => {
        const gap = posterImg.getBoundingClientRect().bottom - sliderWrapper.getBoundingClientRect().bottom;
        const diff = effectiveGapPx - gap;
        if (Math.abs(diff) > 0.5) {
            homeSection.style.setProperty('--home-hero-introslider-poster-overlap', `${targetOverlapPx + diff}px`);
        }
    });
}

function setupHomeHeroIntrosliderPosterGap(desiredGapPx = 8) {
    // Debounced resize to re-measure intro panel height as widths/font metrics change.
    if (homeHeroIntrosliderPosterGapResizeHandler) {
        window.removeEventListener('resize', homeHeroIntrosliderPosterGapResizeHandler);
        homeHeroIntrosliderPosterGapResizeHandler = null;
    }

    let resizeTimer = null;
    homeHeroIntrosliderPosterGapResizeHandler = function() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            syncHomeHeroIntrosliderPosterGap(desiredGapPx);
        }, 120);
    };
    window.addEventListener('resize', homeHeroIntrosliderPosterGapResizeHandler, { passive: true });

    const run = () => syncHomeHeroIntrosliderPosterGap(desiredGapPx);

    // Wait for font/layout settlement if available.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => requestAnimationFrame(run));
    } else {
        requestAnimationFrame(run);
    }

    // Also re-run once the poster image finishes loading.
    const homeSection = document.querySelector('body.home-view .home-section');
    const posterImg = homeSection ? homeSection.querySelector(':scope > picture img.home-poster-wide, :scope > picture img') : null;
    if (posterImg && !posterImg.complete) {
        posterImg.addEventListener('load', () => syncHomeHeroIntrosliderPosterGap(desiredGapPx), { once: true });
    }
}

function teardownHomeViewNavbarScroll() {
    if (homeNavbarScrollHandler) {
        window.removeEventListener('scroll', homeNavbarScrollHandler);
        homeNavbarScrollHandler = null;
    }
    if (homeNavbarResizeHandler) {
        window.removeEventListener('resize', homeNavbarResizeHandler);
        homeNavbarResizeHandler = null;
    }
    if (homeHeroIntrosliderPosterGapResizeHandler) {
        window.removeEventListener('resize', homeHeroIntrosliderPosterGapResizeHandler);
        homeHeroIntrosliderPosterGapResizeHandler = null;
    }
    if (!document.body.classList.contains('home-view')) {
        resetNavHeaderToCssDefaults();
    }
}

/** Same recipe as `.home-section .introslider > .about` in styles.css */
const INTROSLIDER_NAV_GLASS = {
    bgAlpha: 0.6,
    blurPx: 5,
    borderWhiteA: 0.2,
    shadowBlackA: 0.22,
};

/**
 * @param {HTMLElement} navbar
 * @param {number} strength 0–1 (0 = clear glass layer)
 * @param {{ noShadow?: boolean }} [options]
 */
function applyNavbarIntrosliderGlassInline(navbar, strength, options) {
    if (!navbar) return;
    const t = Math.max(0, Math.min(1, strength));
    const noShadow = Boolean(options && options.noShadow);
    const skipBlur =
        typeof window.matchMedia === 'function' &&
        (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
            window.matchMedia('(prefers-reduced-transparency: reduce)').matches);
    if (t <= 0.001) {
        navbar.style.setProperty('background', 'transparent', 'important');
        navbar.style.setProperty('background-color', 'transparent', 'important');
        navbar.style.setProperty('box-shadow', 'none', 'important');
        navbar.style.setProperty('backdrop-filter', 'none', 'important');
        navbar.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        navbar.style.setProperty('border', 'none', 'important');
        return;
    }
    const a = INTROSLIDER_NAV_GLASS.bgAlpha * t;
    const blurPx = INTROSLIDER_NAV_GLASS.blurPx * t;
    navbar.style.setProperty('background', `rgba(0, 49, 83, ${a})`, 'important');
    navbar.style.setProperty('background-color', `rgba(0, 49, 83, ${a})`, 'important');
    if (noShadow) {
        navbar.style.setProperty('box-shadow', 'none', 'important');
    } else {
        navbar.style.setProperty(
            'box-shadow',
            `0 4px 28px rgba(0, 0, 0, ${INTROSLIDER_NAV_GLASS.shadowBlackA * t})`,
            'important'
        );
    }
    const blurVal =
        skipBlur || blurPx <= 0.02 ? 'none' : `blur(${blurPx}px)`;
    navbar.style.setProperty('backdrop-filter', blurVal, 'important');
    navbar.style.setProperty('-webkit-backdrop-filter', blurVal, 'important');
    navbar.style.setProperty(
        'border',
        t < 0.02 ? 'none' : `1px solid rgba(255, 255, 255, ${INTROSLIDER_NAV_GLASS.borderWhiteA * t})`,
        'important'
    );
}

const NAV_HEADER_INLINE_RESET_PROPS = [
    'background',
    'background-color',
    'box-shadow',
    'backdrop-filter',
    '-webkit-backdrop-filter',
    'border',
    'transition',
];

function resetNavHeaderToCssDefaults() {
    const navbar = document.querySelector('.navbar');
    const header = document.querySelector('.header');
    if (navbar) {
        NAV_HEADER_INLINE_RESET_PROPS.forEach((p) => navbar.style.removeProperty(p));
        navbar.classList.remove('transparent');
    }
    if (header) {
        NAV_HEADER_INLINE_RESET_PROPS.forEach((p) => header.style.removeProperty(p));
        header.classList.remove('transparent');
    }
}

const HOME_NAV_FADE_MS = '0.45s';

/**
 * @param {number} opacity 0 = transparent over poster, 1 = introslider-matched frosted glass
 * @param {{ instant?: boolean }} [options] scroll-driven updates use instant so blur snaps on/off
 */
function applyHomeHeroNavbarOpacity(opacity, options) {
    const navbar = document.querySelector('.navbar');
    const header = document.querySelector('.header');
    if (!navbar) return;
    const o = Math.max(0, Math.min(1, opacity));
    const instant = Boolean(options && options.instant);
    const fade = instant ? '0s' : HOME_NAV_FADE_MS;
    const navTransition = `background-color ${fade} ease, box-shadow ${fade} ease, backdrop-filter ${fade} ease, -webkit-backdrop-filter ${fade} ease, border-color ${fade} ease`;
    const headerTransition = `background-color ${fade} ease, box-shadow ${fade} ease`;

    if (o <= 0.001) {
        navbar.style.setProperty('transition', navTransition, 'important');
        applyNavbarIntrosliderGlassInline(navbar, 0);
        navbar.classList.add('transparent');
        if (header) {
            header.style.setProperty('transition', headerTransition, 'important');
            header.style.setProperty('background', 'transparent', 'important');
            header.style.setProperty('background-color', 'transparent', 'important');
            header.style.setProperty('box-shadow', 'none', 'important');
            header.style.setProperty('backdrop-filter', 'none', 'important');
            header.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
            header.style.setProperty('border', 'none', 'important');
            header.classList.add('transparent');
        }
        return;
    }

    navbar.style.setProperty('transition', navTransition, 'important');
    applyNavbarIntrosliderGlassInline(navbar, o);
    navbar.classList.toggle('transparent', o < 0.08);
    if (header) {
        header.style.setProperty('transition', headerTransition, 'important');
        header.style.setProperty('background', 'transparent', 'important');
        header.style.setProperty('background-color', 'transparent', 'important');
        header.style.setProperty('box-shadow', 'none', 'important');
        header.style.setProperty('backdrop-filter', 'none', 'important');
        header.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        header.style.setProperty('border', 'none', 'important');
        header.classList.toggle('transparent', o < 0.08);
    }
}

/** @deprecated use applyHomeHeroNavbarOpacity; kept for teardown / non-scroll paths */
function applyHomeHeroNavbarAppearance(transparent) {
    applyHomeHeroNavbarOpacity(transparent ? 0 : 1);
}

/** Home hero: full frosted nav as soon as the page scrolls (no ramp, no transition on blur). */
const HOME_NAV_SCROLL_INSTANT_THRESHOLD_PX = 2;

/**
 * Scroll-spy: highlight nav tabs (yellow .active) for the home section currently at the navbar anchor line.
 * Order matches DOM: feed → event section → sponsors → speakers → programme → on-demand → registration.
 */
function syncHomeNavSectionFromScroll() {
    if (!document.body.classList.contains('home-view')) return;
    if (document.body.classList.contains('past-talks-open')) return;

    const homeSection = document.querySelector('body.home-view .home-section');
    if (!homeSection) return;

    const nav = document.querySelector('.navbar');
    const navH = nav ? nav.getBoundingClientRect().height : 0;
    const anchorY = navH + 12;

    const speakersEl = document.getElementById('speakers-section');
    const programmeEl =
        document.getElementById('home-programme-title') || homeSection.querySelector(':scope > .programme-section');
    const registrationEl =
        document.getElementById('home-registration-heading') ||
        homeSection.querySelector(':scope > .registration-section');

    let view = 'feed';
    if (registrationEl && registrationEl.getBoundingClientRect().top <= anchorY) {
        view = 'register';
    } else if (programmeEl && programmeEl.getBoundingClientRect().top <= anchorY) {
        view = 'flyer';
    } else if (speakersEl && speakersEl.getBoundingClientRect().top <= anchorY) {
        view = 'speakers';
    }

    setActiveNavView(view);
}

function syncHomeViewNavbarFromScroll() {
    if (!document.body.classList.contains('home-view')) return;
    /* Past talks / video viewer: always full frosted nav (not scroll-gated at top). */
    if (document.body.classList.contains('past-talks-open')) {
        applyHomeHeroNavbarOpacity(1, { instant: true });
        syncPastTalksPrussianStripToNavbar();
        return;
    }
    const poster = document.querySelector('.home-poster-wide');
    if (!poster) {
        applyHomeHeroNavbarOpacity(0, { instant: true });
        return;
    }
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const opacity = scrollY > HOME_NAV_SCROLL_INSTANT_THRESHOLD_PX ? 1 : 0;
    applyHomeHeroNavbarOpacity(opacity, { instant: true });
}

function setupHomeViewNavbarScroll() {
    teardownHomeViewNavbarScroll();
    if (!document.body.classList.contains('home-view')) return;
    homeNavbarScrollHandler = function() {
        syncHomeViewNavbarFromScroll();
        syncHomeNavSectionFromScroll();
    };
    homeNavbarResizeHandler = function() {
        syncHomeViewNavbarFromScroll();
        syncHomeNavSectionFromScroll();
    };
    window.addEventListener('scroll', homeNavbarScrollHandler, { passive: true });
    window.addEventListener('resize', homeNavbarResizeHandler, { passive: true });
    syncHomeViewNavbarFromScroll();
    syncHomeNavSectionFromScroll();
}

// Setup navbar transparency for event section
function setupNavbarTransparency() {
    const navbar = document.querySelector('.navbar');
    const header = document.querySelector('.header');
    const backgroundSection = document.querySelector('.background-section');
    
    if (!navbar || !backgroundSection) return;
    
    // Remove existing scroll listener if it exists
    if (navbarScrollHandler) {
        window.removeEventListener('scroll', navbarScrollHandler);
    }
    
    function handleScroll() {
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const backgroundSectionTop = backgroundSection.offsetTop;
        const backgroundSectionHeight = backgroundSection.offsetHeight;
        const isBackgroundSectionVisible = scrollTop >= backgroundSectionTop && scrollTop < backgroundSectionTop + backgroundSectionHeight;
        
        // Get the big logo position
        const bigLogo = document.querySelector('.logo-container');
        const bigLogoTop = bigLogo ? bigLogo.offsetTop : 0;
        const bigLogoHeight = bigLogo ? bigLogo.offsetHeight : 0;
        const bigLogoBottom = bigLogoTop + bigLogoHeight;
        
        // Get navbar logo
        const navbarLogo = document.querySelector('.navbar .logo');
        
        if (isBackgroundSectionVisible) {
            // In background section - make transparent at top, gradually become opaque
            const scrollProgress = Math.min(scrollTop - backgroundSectionTop, 100) / 100; // Fade over 100px (2× faster than 200px)
            const opacity = Math.min(scrollProgress, 1);
            
            const glassTransition =
                'background-color 0.15s ease, box-shadow 0.15s ease, backdrop-filter 0.15s ease, -webkit-backdrop-filter 0.15s ease, border-color 0.15s ease';
            if (opacity === 0) {
                navbar.style.setProperty('transition', 'none', 'important');
                applyNavbarIntrosliderGlassInline(navbar, 0);
                navbar.classList.add('transparent');
            } else {
                navbar.style.setProperty('transition', glassTransition, 'important');
                navbar.style.setProperty('height', 'auto', 'important');
                applyNavbarIntrosliderGlassInline(navbar, opacity, { noShadow: true });
                navbar.style.setProperty('box-shadow', 'none', 'important');
                navbar.classList.remove('transparent');
            }
            
            if (header) {
                header.style.setProperty('transition', opacity === 0 ? 'none' : 'background-color 0.15s ease', 'important');
                    header.style.setProperty('background', 'transparent', 'important');
                    header.style.setProperty('background-color', 'transparent', 'important');
                    header.style.setProperty('backdrop-filter', 'none', 'important');
                    header.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
                header.style.setProperty('box-shadow', 'none', 'important');
                header.style.setProperty('border', 'none', 'important');
                header.classList.toggle('transparent', opacity === 0);
            }
            
            // Hide navbar logo when big logo is visible
            if (scrollTop < bigLogoBottom) {
                if (navbarLogo) {
                    navbarLogo.style.opacity = '0';
                    navbarLogo.style.transform = 'translateY(-100%)';
                    navbarLogo.style.transition = 'none';
                    navbarLogo.style.pointerEvents = 'none';
                }
            } else {
                if (navbarLogo) {
                    navbarLogo.style.opacity = '1';
                    navbarLogo.style.transition = 'opacity 0.3s ease-in-out, transform 0.3s ease-in-out';
                    navbarLogo.style.transform = 'translateY(0)';
                    navbarLogo.style.pointerEvents = 'auto';
                }
            }
        } else {
            navbar.style.setProperty(
                'transition',
                `background-color 0.3s ease, box-shadow 0.3s ease, backdrop-filter 0.3s ease, -webkit-backdrop-filter 0.3s ease, border-color 0.3s ease`,
                'important'
            );
            navbar.style.setProperty('height', 'auto', 'important');
            applyNavbarIntrosliderGlassInline(navbar, 1);
            navbar.classList.remove('transparent');
            
            if (header) {
                header.style.setProperty('transition', 'all 0.3s ease', 'important');
                header.style.setProperty('background', 'transparent', 'important');
                header.style.setProperty('background-color', 'transparent', 'important');
                header.style.setProperty('box-shadow', 'none', 'important');
                header.style.setProperty('backdrop-filter', 'none', 'important');
                header.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
                header.style.setProperty('border', 'none', 'important');
                header.classList.remove('transparent');
            }
            
            // Show navbar logo when not in background section
            if (navbarLogo) {
                navbarLogo.style.opacity = '1';
                navbarLogo.style.transition = 'opacity 0.3s ease-in-out, transform 0.3s ease-in-out';
                navbarLogo.style.transform = 'translateY(0)';
                navbarLogo.style.pointerEvents = 'auto';
            }
        }
    }
    
    navbarScrollHandler = handleScroll;
    window.addEventListener('scroll', handleScroll);
    handleScroll(); // Initial call
}

// Update navbar transparency when event section is shown
function updateNavbarForEventSection() {
    const navbar = document.querySelector('.navbar');
    const header = document.querySelector('.header');
    if (!navbar) {
        return;
    }
    
    // Set initial transparent state for navbar - remove ALL background properties
    navbar.style.setProperty('background', 'transparent', 'important');
    navbar.style.setProperty('background-color', 'transparent', 'important');
    navbar.style.setProperty('box-shadow', 'none', 'important');
    navbar.style.setProperty('z-index', '9999', 'important');
    navbar.style.setProperty('transition', 'none', 'important'); // Remove transition for instant transparency
    navbar.style.setProperty('opacity', '1', 'important'); // Ensure full opacity
    navbar.style.setProperty('backdrop-filter', 'none', 'important');
    navbar.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    navbar.style.setProperty('border', 'none', 'important');
    navbar.classList.add('transparent');
    
    // Also make the header element transparent - remove all visual effects
    if (header) {
        header.style.setProperty('background', 'transparent', 'important');
        header.style.setProperty('background-color', 'transparent', 'important');
        header.style.setProperty('box-shadow', 'none', 'important');
        header.style.setProperty('border', 'none', 'important');
        header.style.setProperty('backdrop-filter', 'none', 'important');
        header.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        header.style.setProperty('transition', 'none', 'important'); // Remove transition
        header.style.setProperty('opacity', '1', 'important'); // Ensure full opacity
        header.classList.add('transparent'); // Add class for CSS targeting
    }
    
    // Re-setup scroll listener for the new event section
    setTimeout(() => {
        setupNavbarTransparency();
    }, 100);
}

/* When Snippets save in another tab, refresh home Location text without reload. */
if (typeof window !== 'undefined' && !window.__tbsHomeLocationStorageBound) {
    window.__tbsHomeLocationStorageBound = true;
    window.addEventListener('storage', function (ev) {
        if (ev.key === TBS_TEXTEDITOR_HOME_LOCATION_LS_KEY) {
            const el = document.querySelector('body.home-view .home-section .location-text-body');
            if (!el) return;
            el.innerHTML = ev.newValue != null ? String(ev.newValue) : '';
            return;
        }
        if (ev.key === TBS_TEXTEDITOR_HOME_PROGRAMMEINFO_LS_KEY) {
            firestoreHomeCache.programmeBandIntroSnippets = { value: '', fetchedAt: 0, promise: null };
        }
    });
}

// Initialize the blog when page loads
document.addEventListener('DOMContentLoaded', async function() {
    // Setup initial event listeners first (non-blocking)
    setupEventListeners();
    setupNavbarTransparency();
    setupMobileMenu();

    // Bind header nav before home feed load so Past talks / Register work even if showFeedContent() throws or hangs
    await setupNavigationListeners();

    try {
        await Promise.race([
            showFeedContent(),
            new Promise(function (_, reject) {
                setTimeout(function () {
                    reject(
                        new Error(
                            'Home initialisation exceeded 120s (network or Firebase still stalled)'
                        )
                    );
                }, 120000);
            }),
        ]);
    } catch (err) {
        console.error('showFeedContent failed or timed out:', err);
    }
    revealStuckHomeStageBands(document.querySelector('.everything .home-section'));
    scrollHomeToTop();

    // Warm the Past talks dataset after first paint/interaction.
    scheduleBackgroundPastTalksWarmup();
    
    // Monitor featured content title for line breaks
    monitorFeaturedTitleBreak();
    
    // Setup responsive text truncation for featured content
    setupResponsiveTextTruncation();
    
});

// Populate categories and topics in the initial HTML
function populateInitialFilters() {
    // Wait a bit for posts to load, then populate filters
    setTimeout(() => {
        const categories = getUniqueCategories();
        const topics = getUniqueTopics();
        const filterTabs = document.getElementById('filterTabs');
        
        if (filterTabs) {
            // Keep the "All" button and add dynamic categories
            const allButton = filterTabs.querySelector('[data-category="all"]');
            const categoryButtons = categories.map(category => 
                `<button class="filter-btn" data-category="${category}">${category}</button>`
            ).join('');
            
            filterTabs.innerHTML = allButton.outerHTML + categoryButtons;
            
            // Add topic filters if they exist
            if (topics.length > 0) {
                const topicFilters = document.createElement('div');
                topicFilters.className = 'filter-tabs topic-filters';
                topicFilters.innerHTML = `
                    <button class="filter-btn topic-btn active" data-topic="all">All</button>
                    ${topics.map(topic => `<button class="filter-btn topic-btn" data-topic="${topic}">${topic}</button>`).join('')}
                `;
                filterTabs.parentNode.appendChild(topicFilters);
            }
            
            // Re-setup event listeners for the new buttons
            setupEventListeners();
            setupTopicButtonListeners();
        }
    }, 500); // Reduced delay since data loads faster now
}

