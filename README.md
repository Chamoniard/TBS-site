# Modern Blog Website

A beautiful, responsive blog website built with HTML, CSS, and JavaScript. Features a modern design with smooth animations, category filtering, and mobile responsiveness.

## Features

- **Responsive Design**: Works perfectly on desktop, tablet, and mobile devices
- **Category Filtering**: Filter posts by Technology, Lifestyle, Travel, or view all
- **Modern UI/UX**: Clean, modern design with smooth animations and hover effects
- **Interactive Elements**: 
  - Mobile hamburger menu
  - Newsletter subscription
  - Load more posts functionality
  - Smooth scrolling navigation
- **Sample Content**: 8 sample blog posts with different categories
- **Accessibility**: Proper semantic HTML and keyboard navigation support

## Files Structure

```
blog-website/
├── index.html          # Main HTML file
├── styles.css          # CSS styles and responsive design
├── script.js           # JavaScript functionality
└── README.md           # This file
```

## How to Use

1. **Open the website**: Simply open `index.html` in your web browser
2. **Navigate**: Use the navigation menu or scroll through the page
3. **Filter posts**: Click on category buttons (All, Technology, Lifestyle, Travel) to filter posts
4. **Load more**: Click "Load More Posts" to see additional content
5. **Subscribe**: Enter your email in the newsletter section to subscribe
6. **Mobile**: On mobile devices, use the hamburger menu for navigation

## Customization

### Adding New Blog Posts

Edit the `blogPosts` array in `script.js`:

```javascript
{
    id: 9,
    title: "Your Post Title",
    excerpt: "Your post excerpt...",
    category: "technology", // or "lifestyle", "travel"
    date: "2024-01-20",
    readTime: "5 min read",
    likes: 0,
    comments: 0,
    image: "🚀" // Emoji or icon
}
```

### Changing Colors

Modify the CSS variables in `styles.css`:

```css
:root {
    --primary-color: #2563eb;
    --secondary-color: #1e293b;
    --text-color: #333;
    --background-color: #ffffff;
}
```

### Adding New Categories

1. Add the category button in `index.html`:
```html
<button class="filter-btn" data-filter="newcategory">New Category</button>
```

2. Update the JavaScript filter logic in `script.js` if needed

## Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## Technologies Used

- **HTML5**: Semantic markup
- **CSS3**: Modern styling with Flexbox and Grid
- **JavaScript (ES6+)**: Interactive functionality
- **Font Awesome**: Icons
- **Google Fonts**: Inter font family

## Performance Features

- Optimized images using CSS gradients and emojis
- Smooth animations with CSS transitions
- Efficient JavaScript with event delegation
- Responsive images and layouts
- Minimal external dependencies

## Future Enhancements

- Backend integration for dynamic content
- User authentication and comments
- Search functionality
- Dark mode toggle
- SEO optimization
- Progressive Web App features

## License

This project is open source and available under the MIT License.


