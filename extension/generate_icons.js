const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
}

// Minimal valid PNG generator function for placeholder extension icons
function createPNG(width, height) {
    const { createCanvas } = require('canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#6366f1');
    gradient.addColorStop(1, '#a855f7');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(width/2, height/2, width/2 - 1, 0, Math.PI * 2);
    ctx.fill();

    // Headphone icon text
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(width * 0.55)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎧', width / 2, height / 2);

    return canvas.toBuffer('image/png');
}

try {
    fs.writeFileSync(path.join(iconsDir, 'icon16.png'), createPNG(16, 16));
    fs.writeFileSync(path.join(iconsDir, 'icon48.png'), createPNG(48, 48));
    fs.writeFileSync(path.join(iconsDir, 'icon128.png'), createPNG(128, 128));
    console.log('Icons generated successfully with canvas!');
} catch (e) {
    console.log('Canvas module not available, generating SVG/PNG fallback icons...');
    // Pure binary PNG fallback so extension loads cleanly without error
    const createFallbackPNG = (size) => {
        // Simple valid 1x1 base PNG expanded or simple valid PNG header
        const base64Png = "iVBORw0KGgoAAAANSU5ACC1AAGP8AAAAAElFTkSuQmCC";
        return Buffer.from(base64Png, "base64");
    };
    fs.writeFileSync(path.join(iconsDir, 'icon16.png'), createFallbackPNG(16));
    fs.writeFileSync(path.join(iconsDir, 'icon48.png'), createFallbackPNG(48));
    fs.writeFileSync(path.join(iconsDir, 'icon128.png'), createFallbackPNG(128));
}
