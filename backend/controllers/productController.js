const Product = require('../models/Product');
const cloudinary = require('../config/cloudinary');
const { getCache, setCache, delCache } = require('../utils/cache');
const { publishMessage } = require('../config/rabbitmq');

const getProducts = async (req, res) => {
  try {
    const cached = await getCache('products:all');
    if (cached) return res.json(cached);

    const products = await Product.find({});
    await setCache('products:all', products, 300);
    res.json(products);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getProductById = async (req, res) => {
  try {
    const cached = await getCache(`products:${req.params.id}`);
    if (cached) return res.json(cached);

    const product = await Product.findById(req.params.id);
    if (product) {
      await setCache(`products:${req.params.id}`, product, 300);
      res.json(product);
    } else {
      res.status(404).json({ message: 'Product not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createProduct = async (req, res) => {
  try {
    const { name, description, price, category, stock } = req.body;
    let imageUrl = '';
    if (req.file) {
      const result = await cloudinary.uploader.upload(req.file.path);
      imageUrl = result.secure_url;
    }
    const product = new Product({ name, description, price, category, stock, imageUrl });
    const createdProduct = await product.save();

    await delCache('products:all', 'analytics:stats');
    await publishMessage('analytics.invalidate', { source: 'product.created' });

    res.status(201).json(createdProduct);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateProduct = async (req, res) => {
  try {
    const { name, description, price, category, stock } = req.body;
    const product = await Product.findById(req.params.id);
    if (product) {
      product.name = name || product.name;
      product.description = description || product.description;
      product.price = price || product.price;
      product.category = category || product.category;
      product.stock = stock || product.stock;

      if (req.file) {
        const result = await cloudinary.uploader.upload(req.file.path);
        product.imageUrl = result.secure_url;
      }
      const updatedProduct = await product.save();

      await delCache('products:all', `products:${req.params.id}`, 'analytics:stats');
      await publishMessage('analytics.invalidate', { source: 'product.updated' });

      res.json(updatedProduct);
    } else {
      res.status(404).json({ message: 'Product not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (product) {
      await product.deleteOne();

      await delCache('products:all', `products:${req.params.id}`, 'analytics:stats');
      await publishMessage('analytics.invalidate', { source: 'product.deleted' });

      res.json({ message: 'Product removed' });
    } else {
      res.status(404).json({ message: 'Product not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getProducts, getProductById, createProduct, updateProduct, deleteProduct };
